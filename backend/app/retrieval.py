"""Period/page-aware document chunking, local MiniLM embeddings, and authorised pgvector retrieval."""

from dataclasses import dataclass
from functools import lru_cache
import math
import os
import re
from typing import Callable
from uuid import UUID, uuid4

from sqlalchemy import delete, select
from sqlalchemy.engine import Connection

from app.settings import setting

from app.models import document_chunks, documents
from app.financial_dates import FY_SPAN_RE, MARCH_31_PATTERNS, format_financial_year
from app.schemas.documents import DocumentExtractionSnapshot, ExtractedPage
from app.schemas.evidence import MAX_TOP_K, MODEL_MAX_TOKENS, RetrievalResponse, RetrievedPassage
from app.workspace_access import document_scope, owned_business, require_document

EMBEDDING_MODEL_ID = "sentence-transformers/all-MiniLM-L6-v2"
EMBEDDING_DIM = 384
CHUNK_TARGET_TOKENS = 220
CHUNK_OVERLAP_WORDS = 16
MAX_HEADER_TOKENS = 72
MAX_CHUNKS_PER_DOCUMENT = 400


class EmbeddingUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class PreparedChunk:
    chunk_index: int
    page_number: int
    section: str | None
    period_years: list[int]
    content: str
    token_count: int


@dataclass(frozen=True)
class EmbeddedChunk:
    chunk: PreparedChunk
    embedding: list[float]


def _normalize_line(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _extract_page_period_years(
    snapshot: DocumentExtractionSnapshot, page: ExtractedPage
) -> list[int]:
    years: set[int] = set()
    for candidate in snapshot.candidates:
        if candidate.page_number == page.page_number and candidate.year_start is not None:
            years.add(candidate.year_start)
    for source in (page.period_context or "", page.text):
        for match in FY_SPAN_RE.finditer(source):
            start = int(match.group(1))
            end_raw = match.group(2)
            end = int(end_raw) if len(end_raw) == 4 else (start // 100) * 100 + int(end_raw)
            if end == start + 1 and 1990 <= start <= 2100:
                years.add(start)
        for pattern in MARCH_31_PATTERNS:
            for match in pattern.finditer(source):
                end_year = int(match.group(1))
                if 1991 <= end_year <= 2100:
                    years.add(end_year - 1)
    return sorted(years)


def _build_page_header(
    filename: str,
    page: ExtractedPage,
    period_years: list[int],
    token_len: Callable[[str], int],
) -> tuple[str, str | None]:
    section = _normalize_line(page.statement_title or "")[:255] or None
    parts = [filename.strip()[:80], f"Page {page.page_number}"]
    if section:
        parts.append(section[:80])
    if period_years:
        parts.append(", ".join(format_financial_year(y) for y in period_years[:4]))
    if page.unit:
        parts.append(f"Unit: {page.unit}")
    header = " | ".join(parts)
    if token_len(header) <= MAX_HEADER_TOKENS:
        return header, section
    compact = f"{filename.strip()[:48]} | Page {page.page_number}"
    if period_years:
        compact += f" | {', '.join(format_financial_year(y) for y in period_years[:3])}"
    if token_len(compact) <= MAX_HEADER_TOKENS:
        return compact, section
    return f"Page {page.page_number}", section


def _split_oversized_text(
    prefix: str,
    text: str,
    token_len: Callable[[str], int],
    max_tokens: int,
) -> list[str]:
    """Split one long line/paragraph into segments where `prefix + '\\n' + seg` <= max_tokens."""
    words = text.split()
    if not words:
        return []
    pieces: list[str] = []
    start = 0
    while start < len(words):
        # Find the longest word slice starting at `start` that fits within max_tokens.
        lo, hi = 1, len(words) - start
        best = 0
        while lo <= hi:
            mid = (lo + hi) // 2
            candidate = f"{prefix}\n{' '.join(words[start : start + mid])}"
            if token_len(candidate) <= max_tokens:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        if best > 0:
            pieces.append(" ".join(words[start : start + best]))
            if start + best >= len(words):
                break
            step = max(1, best - CHUNK_OVERLAP_WORDS)
            start += step
        else:
            # Single token/word exceeds remaining budget; split by characters.
            word = words[start]
            c_start = 0
            while c_start < len(word):
                lo_c, hi_c = 1, len(word) - c_start
                best_c = 1
                while lo_c <= hi_c:
                    mid_c = (lo_c + hi_c) // 2
                    candidate = f"{prefix}\n{word[c_start : c_start + mid_c]}"
                    if token_len(candidate) <= max_tokens:
                        best_c = mid_c
                        lo_c = mid_c + 1
                    else:
                        hi_c = mid_c - 1
                pieces.append(word[c_start : c_start + best_c])
                c_start += best_c
            start += 1
    return pieces


def _page_units(page: ExtractedPage) -> list[tuple[str | None, str]]:
    """Return `(table_header_or_none, line)` units preserving table headers and narrative notes."""
    units: list[tuple[str | None, str]] = []
    table_lines_seen: set[str] = set()
    for table in page.tables:
        if not table.rows:
            continue
        header_row = " | ".join(_normalize_line(cell) for cell in table.rows[0] if _normalize_line(cell))
        table_lines_seen.add(_normalize_line(" ".join(table.rows[0])).lower())
        if len(table.rows) == 1 and header_row:
            units.append((None, header_row))
            continue
        for row in table.rows[1:]:
            row_text = " | ".join(_normalize_line(cell) for cell in row if _normalize_line(cell))
            if not row_text:
                continue
            table_lines_seen.add(_normalize_line(" ".join(row)).lower())
            units.append((header_row or None, row_text))
    for raw_line in page.text.splitlines():
        line = _normalize_line(raw_line)
        if not line:
            continue
        if line.lower() in table_lines_seen:
            continue
        units.append((None, line))
    return units


@lru_cache(maxsize=1)
def get_embedding_model():
    local_only = setting("EMBEDDING_LOCAL_FILES_ONLY", "1").strip() != "0"
    if local_only:
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    try:
        from sentence_transformers import SentenceTransformer

        return SentenceTransformer(
            EMBEDDING_MODEL_ID, device="cpu", local_files_only=local_only
        )
    except Exception as exc:
        raise EmbeddingUnavailableError(
            "Local embedding model is unavailable. Ensure all-MiniLM-L6-v2 is cached locally."
        ) from exc


def count_model_tokens(text: str, model=None) -> int:
    active_model = model if model is not None else get_embedding_model()
    return len(
        active_model.tokenizer.encode(
            text, add_special_tokens=True, truncation=False
        )
    )


def embed_texts(texts: list[str], model=None) -> list[list[float]]:
    if not texts:
        return []
    active_model = model if model is not None else get_embedding_model()
    try:
        raw_vectors = active_model.encode(
            texts, normalize_embeddings=True, show_progress_bar=False
        )
    except Exception as exc:
        raise EmbeddingUnavailableError("Failed to compute local embeddings.") from exc
    vectors: list[list[float]] = []
    for vec in raw_vectors:
        values = [float(x) for x in vec.tolist()]
        if len(values) != EMBEDDING_DIM or not all(math.isfinite(x) for x in values):
            raise EmbeddingUnavailableError("Embedding vector failed dimension or finiteness check.")
        vectors.append(values)
    return vectors


def build_document_chunks(
    snapshot: DocumentExtractionSnapshot,
    filename: str,
    *,
    token_len: Callable[[str], int] | None = None,
    max_tokens: int = CHUNK_TARGET_TOKENS,
) -> list[PreparedChunk]:
    """Chunk an extracted PDF snapshot into period/page-aware passages within the token limit."""
    if not 32 <= max_tokens <= MODEL_MAX_TOKENS:
        raise ValueError(f"max_tokens must be between 32 and {MODEL_MAX_TOKENS}")
    measure = token_len if token_len is not None else count_model_tokens
    chunks: list[PreparedChunk] = []

    for page in snapshot.pages:
        period_years = _extract_page_period_years(snapshot, page)
        header, section = _build_page_header(filename, page, period_years, measure)
        units = _page_units(page)
        if not units:
            continue

        current_table_header: str | None = None
        current_lines: list[str] = []

        def render(table_header: str | None, lines: list[str]) -> str:
            parts = [header]
            if table_header:
                parts.append(table_header)
            parts.extend(lines)
            return "\n".join(parts)

        def flush() -> None:
            nonlocal current_lines, current_table_header
            if not current_lines:
                return
            if len(chunks) >= MAX_CHUNKS_PER_DOCUMENT:
                current_lines = []
                current_table_header = None
                return
            content = render(current_table_header, current_lines)
            toks = measure(content)
            if toks > MODEL_MAX_TOKENS:
                raise ValueError(
                    f"Chunk exceeded model max token limit ({toks} > {MODEL_MAX_TOKENS})"
                )
            chunks.append(
                PreparedChunk(
                    chunk_index=len(chunks),
                    page_number=page.page_number,
                    section=section,
                    period_years=period_years,
                    content=content,
                    token_count=toks,
                )
            )
            current_lines = []

        for table_header, line in units:
            if len(chunks) >= MAX_CHUNKS_PER_DOCUMENT:
                break
            # Switch chunk boundary cleanly when transitioning between tables/narrative.
            if current_lines and table_header != current_table_header:
                flush()
            current_table_header = table_header
            prefix = render(current_table_header, [])
            candidate_text = render(current_table_header, [*current_lines, line])
            if measure(candidate_text) <= max_tokens:
                current_lines.append(line)
                continue
            if current_lines:
                flush()
                current_table_header = table_header
                prefix = render(current_table_header, [])
            single_candidate = render(current_table_header, [line])
            if measure(single_candidate) <= max_tokens:
                current_lines = [line]
            else:
                for piece in _split_oversized_text(prefix, line, measure, max_tokens):
                    if len(chunks) >= MAX_CHUNKS_PER_DOCUMENT:
                        break
                    current_lines = [piece]
                    flush()
                    current_table_header = table_header
        flush()
        if len(chunks) >= MAX_CHUNKS_PER_DOCUMENT:
            break

    return chunks


def prepare_embedded_chunks(
    snapshot: DocumentExtractionSnapshot,
    filename: str,
    *,
    model=None,
) -> list[EmbeddedChunk]:
    active_model = model if model is not None else get_embedding_model()
    chunks = build_document_chunks(
        snapshot,
        filename,
        token_len=lambda text: count_model_tokens(text, model=active_model),
    )
    if not chunks:
        return []
    vectors = embed_texts([c.content for c in chunks], model=active_model)
    return [EmbeddedChunk(chunk=c, embedding=v) for c, v in zip(chunks, vectors, strict=True)]


def replace_document_chunks(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    document_id: UUID,
    embedded_chunks: list[EmbeddedChunk],
) -> int:
    connection.execute(
        delete(document_chunks).where(document_chunks.c.document_id == document_id)
    )
    if not embedded_chunks:
        return 0
    rows = [
        dict(
            id=uuid4(),
            document_id=document_id,
            business_id=business_id,
            owner_id=owner_id,
            chunk_index=item.chunk.chunk_index,
            page_number=item.chunk.page_number,
            section=item.chunk.section,
            period_years=item.chunk.period_years,
            content=item.chunk.content,
            token_count=item.chunk.token_count,
            embedding_model=EMBEDDING_MODEL_ID,
            embedding=item.embedding,
        )
        for item in embedded_chunks
    ]
    connection.execute(document_chunks.insert(), rows)
    return len(rows)


def retrieve_passages(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    query: str,
    *,
    top_k: int = MAX_TOP_K,
    year_start: int | None = None,
    document_id: UUID | None = None,
    model=None,
) -> RetrievalResponse:
    owned_business(connection, owner_id, business_id)
    if document_id is not None:
        require_document(connection, owner_id, business_id, document_id)

    bounded_k = max(1, min(top_k, MAX_TOP_K))
    query_vec = embed_texts([query.strip()], model=model)[0]
    distance = document_chunks.c.embedding.cosine_distance(query_vec).label("distance")

    stmt = (
        select(
            document_chunks.c.id,
            document_chunks.c.document_id,
            documents.c.filename,
            document_chunks.c.chunk_index,
            document_chunks.c.page_number,
            document_chunks.c.section,
            document_chunks.c.period_years,
            document_chunks.c.content,
            document_chunks.c.token_count,
            distance,
        )
        .join(documents, document_chunks.c.document_id == documents.c.id)
        .where(
            document_chunks.c.owner_id == owner_id,
            document_chunks.c.business_id == business_id,
            *document_scope(owner_id, business_id),
            documents.c.status == "ready",
        )
    )
    if document_id is not None:
        stmt = stmt.where(document_chunks.c.document_id == document_id)
    if year_start is not None:
        stmt = stmt.where(document_chunks.c.period_years.contains([year_start]))

    rows = (
        connection.execute(
            stmt.order_by(
                distance.asc(),
                document_chunks.c.page_number.asc(),
                document_chunks.c.chunk_index.asc(),
            ).limit(bounded_k)
        )
        .mappings()
        .all()
    )

    passages = [
        RetrievedPassage(
            chunk_id=row["id"],
            document_id=row["document_id"],
            filename=row["filename"],
            chunk_index=row["chunk_index"],
            page_number=row["page_number"],
            section=row["section"],
            period_years=list(row["period_years"] or []),
            content=row["content"],
            token_count=row["token_count"],
            score=round(max(-1.0, min(1.0, 1.0 - float(row["distance"]))), 6),
        )
        for row in rows
    ]
    return RetrievalResponse(
        embedding_model=EMBEDDING_MODEL_ID,
        max_tokens=MODEL_MAX_TOKENS,
        passages=passages,
    )
