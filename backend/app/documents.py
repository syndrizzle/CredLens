import hashlib
import io
import json
import os
import re
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.engine import Connection, Engine

from app.models import businesses, documents
from app.pdf_limits import MAX_PDF_BYTES, MAX_PDF_PAGES, WALL_SECONDS
from app.schemas import DocumentSummary

READ_CHUNK_BYTES = 64 * 1024
ALLOWED_CONTENT_TYPES = {"", "application/pdf", "application/x-pdf", "application/octet-stream", "binary/octet-stream"}
PDF_ERRORS = {
    "encrypted_pdf": "Password-protected or encrypted PDFs are not supported.",
    "corrupted_pdf": "PDF could not be parsed. Check the file and upload it again.",
    "empty_pdf_pages": "PDF contains no readable pages.",
    "too_many_pages": "PDF exceeds the 50-page limit.",
    "scanned_only_pdf": "Scanned or image-only PDFs without selectable digital text are not supported.",
    "parser_resource_limit": "PDF exceeds the parser resource budget. Use a smaller PDF or manual entry.",
    "parser_timeout": "PDF processing timed out. Use a smaller PDF or retry processing.",
    "parser_limits_unavailable": "Parser resource limits could not be installed on this host.",
    "parser_unavailable": "PDF processing is unavailable. Check the local backend and retry.",
    "file_too_large": "PDF exceeds the 20 MB maximum file size limit.",
}


class DocumentRejectError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code, self.code, self.message = status_code, code, message


def get_storage_root() -> Path:
    configured = os.getenv("DOCUMENT_STORAGE_DIR", "").strip()
    return Path(configured).resolve() if configured else (Path(__file__).resolve().parents[1] / ".storage" / "documents").resolve()


def document_file_path(owner_id: UUID, business_id: UUID, document_id: UUID) -> Path:
    root = get_storage_root()
    target = (root / str(owner_id) / str(business_id) / f"{document_id}.pdf").resolve()
    if root not in target.parents:
        raise ValueError("Invalid document storage path")
    return target


def sanitize_pdf_filename(filename: str | None) -> str:
    raw = (filename or "").strip()
    base = Path(raw.replace("\\", "/")).name.strip()
    base = re.sub(r"[\x00-\x1f\x7f]+", "", base)
    if not base or not base.lower().endswith(".pdf") or len(base) <= 4:
        raise DocumentRejectError(
            415,
            "unsupported_file_type",
            "Only PDF files (.pdf) are supported.",
        )
    if len(base) > 255:
        stem = base[:-4][:251].rstrip()
        base = f"{stem}.pdf"
    return base


def read_bounded_upload(stream: BinaryIO, content_type: str | None) -> bytes:
    normalized_type = (content_type or "").split(";")[0].strip().lower()
    if normalized_type not in ALLOWED_CONTENT_TYPES:
        raise DocumentRejectError(
            415,
            "unsupported_media_type",
            "Unsupported content type. Upload a digital PDF file (application/pdf).",
        )
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = stream.read(READ_CHUNK_BYTES)
        if not chunk:
            break
        total += len(chunk)
        if total > MAX_PDF_BYTES:
            raise DocumentRejectError(
                413,
                "file_too_large",
                "PDF exceeds the 20 MB maximum file size limit.",
            )
        chunks.append(chunk)
    if total == 0:
        raise DocumentRejectError(
            400,
            "empty_file",
            "Uploaded PDF file is empty.",
        )
    data = b"".join(chunks)
    header_window = data[:1024]
    pdf_pos = header_window.find(b"%PDF-")
    if pdf_pos == -1 or (pdf_pos > 0 and header_window[:pdf_pos].strip()):
        raise DocumentRejectError(
            415,
            "invalid_pdf_header",
            "File does not have a valid PDF header.",
        )
    return data


def inspect_pdf_file(path: Path) -> tuple[int, int]:
    env = {key: value for key, value in os.environ.items()
           if key in {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL"}}
    try:
        result = subprocess.run(
            [sys.executable, "-m", "app.pdf_worker", str(path)],
            cwd=Path(__file__).resolve().parents[1], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=WALL_SECONDS,
        )
    except subprocess.TimeoutExpired:
        raise DocumentRejectError(422, "parser_timeout", PDF_ERRORS["parser_timeout"]) from None
    except OSError:
        raise DocumentRejectError(503, "parser_unavailable", PDF_ERRORS["parser_unavailable"]) from None
    if result.returncode:
        raise DocumentRejectError(422, "parser_resource_limit", PDF_ERRORS["parser_resource_limit"])
    try:
        body = json.loads(result.stdout)
        if "error" in body:
            code = body["error"]
            if code not in PDF_ERRORS:
                raise ValueError
            raise DocumentRejectError(422, code, PDF_ERRORS[code])
        pages, chars = body["pages"], body["chars"]
        if type(pages) is not int or not 1 <= pages <= MAX_PDF_PAGES or type(chars) is not int or chars <= 0:
            raise ValueError
        return pages, chars
    except (ValueError, KeyError, TypeError):
        raise DocumentRejectError(503, "parser_unavailable", PDF_ERRORS["parser_unavailable"]) from None


def inspect_pdf_bytes(data: bytes) -> tuple[int, int]:
    data = read_bounded_upload(io.BytesIO(data), "application/pdf")
    with tempfile.TemporaryDirectory(prefix="credlens-pdf-") as directory:
        path = Path(directory) / "input.pdf"
        path.write_bytes(data)
        return inspect_pdf_file(path)


def _ensure_owned_business(connection: Connection, owner_id: UUID, business_id: UUID) -> None:
    if connection.execute(select(businesses.c.id).where(
        businesses.c.id == business_id, businesses.c.owner_id == owner_id)).scalar_one_or_none() is None:
        raise LookupError("Business not found")


def _try_job_lock(connection: Connection, owner_id: UUID) -> bool:
    key = int.from_bytes(hashlib.blake2b(owner_id.bytes, digest_size=8, person=b"credlens-pdf").digest(), signed=True)
    return connection.execute(select(func.pg_try_advisory_xact_lock(key))).scalar_one()


def _mark_interrupted(connection: Connection, owner_id: UUID, business_id: UUID | None = None) -> None:
    stmt = documents.update().where(documents.c.owner_id == owner_id, documents.c.status == "processing")
    if business_id is not None:
        stmt = stmt.where(documents.c.business_id == business_id)
    connection.execute(stmt.values(status="failed", page_count=None, extracted_char_count=None,
        error_code="interrupted_job", error_message="Processing was interrupted. Retry processing to continue.", updated_at=func.now()))


def reconcile_interrupted_documents(connection: Connection, owner_id: UUID, business_id: UUID | None = None) -> None:
    stmt = select(documents.c.id).where(documents.c.owner_id == owner_id, documents.c.status == "processing").limit(1)
    if business_id is not None:
        stmt = stmt.where(documents.c.business_id == business_id)
    if connection.execute(stmt).first() is not None and _try_job_lock(connection, owner_id):
        _mark_interrupted(connection, owner_id, business_id)


@contextmanager
def _document_job(engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID | None = None):
    # A transaction-scoped advisory lock also works through Neon's transaction pooler.
    with engine.begin() as gate:
        if document_id is None:
            _ensure_owned_business(gate, owner_id, business_id)
        else:
            _owned_document(gate, owner_id, business_id, document_id)
        if not _try_job_lock(gate, owner_id):
            raise DocumentRejectError(409, "active_job_exists", "Another PDF job is active. Wait for it to finish.")
        with engine.begin() as connection:
            _mark_interrupted(connection, owner_id)
        yield


def _row_to_summary(row) -> DocumentSummary:
    return DocumentSummary(**{key: row[key] for key in DocumentSummary.model_fields})


def _owned_document(connection: Connection, owner_id: UUID, business_id: UUID, document_id: UUID):
    _ensure_owned_business(connection, owner_id, business_id)
    row = connection.execute(select(documents).where(documents.c.id == document_id,
        documents.c.business_id == business_id, documents.c.owner_id == owner_id)).mappings().one_or_none()
    if row is None:
        raise LookupError("Document not found")
    return row


def list_documents(connection: Connection, owner_id: UUID, business_id: UUID) -> list[DocumentSummary]:
    _ensure_owned_business(connection, owner_id, business_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    rows = connection.execute(select(documents).where(documents.c.business_id == business_id,
        documents.c.owner_id == owner_id).order_by(documents.c.created_at.desc(), documents.c.id.desc())).mappings()
    return [_row_to_summary(row) for row in rows]


def _write_pdf_atomically(target: Path, data: bytes) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp_path = target.with_suffix(".tmp")
    try:
        with os.fdopen(os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as output:
            output.write(data)
        os.replace(tmp_path, target)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _remove_file_and_empty_dirs(target: Path) -> None:
    target.unlink(missing_ok=True)
    target.with_suffix(".tmp").unlink(missing_ok=True)
    root = get_storage_root()
    parent = target.parent
    while parent != root and root in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _finish_processing(engine: Engine, document_id: UUID, path: Path) -> DocumentSummary:
    try:
        if not path.is_file():
            raise DocumentRejectError(422, "missing_storage_file", "Stored PDF is unavailable. Remove and re-upload it.")
        pages, chars = inspect_pdf_file(path)
        values = dict(status="ready", page_count=pages, extracted_char_count=chars, error_code=None, error_message=None)
    except DocumentRejectError as exc:
        values = dict(status="failed", page_count=None, extracted_char_count=None, error_code=exc.code, error_message=exc.message)
    with engine.begin() as connection:
        row = connection.execute(documents.update().where(documents.c.id == document_id)
            .values(**values, updated_at=func.now()).returning(documents)).mappings().one()
        summary = _row_to_summary(row)
    return summary


def upload_and_process_document(engine: Engine, owner_id: UUID, business_id: UUID,
                                filename: str | None, content_type: str | None, stream: BinaryIO) -> DocumentSummary:
    with _document_job(engine, owner_id, business_id):
        name = sanitize_pdf_filename(filename)
        data = read_bounded_upload(stream, content_type)
        document_id = uuid4()
        path = document_file_path(owner_id, business_id, document_id)
        # Commit metadata before writing: a crash can leave a recoverable row, never an untracked file.
        with engine.begin() as connection:
            connection.execute(documents.insert().values(id=document_id, owner_id=owner_id, business_id=business_id,
                filename=name, sha256=hashlib.sha256(data).hexdigest(), byte_size=len(data), status="processing"))
        try:
            _write_pdf_atomically(path, data)
        except OSError:
            with engine.begin() as connection:
                row = connection.execute(documents.update().where(documents.c.id == document_id)
                    .values(status="failed", error_code="storage_unavailable", error_message="PDF storage failed. Remove and re-upload the file.", updated_at=func.now())
                    .returning(documents)).mappings().one()
                summary = _row_to_summary(row)
            return summary
        return _finish_processing(engine, document_id, path)


def retry_document_processing(engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID) -> DocumentSummary:
    with _document_job(engine, owner_id, business_id, document_id):
        with engine.begin() as connection:
            row = _owned_document(connection, owner_id, business_id, document_id)
            if row["status"] == "ready" or row["error_code"] == "deletion_pending":
                raise DocumentRejectError(409, "not_retryable", "Document is ready or pending removal; refresh its status.")
            connection.execute(documents.update().where(documents.c.id == document_id)
                .values(status="processing", page_count=None, extracted_char_count=None, error_code=None, error_message=None, updated_at=func.now()))
        return _finish_processing(engine, document_id, document_file_path(owner_id, business_id, document_id))


def get_document_file(connection: Connection, owner_id: UUID, business_id: UUID, document_id: UUID) -> tuple[DocumentSummary, Path]:
    row = _owned_document(connection, owner_id, business_id, document_id)
    path = document_file_path(owner_id, business_id, document_id)
    if row["status"] != "ready" or not path.is_file():
        raise LookupError("Document file not ready or unavailable")
    return _row_to_summary(row), path


def delete_document(engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID) -> None:
    with _document_job(engine, owner_id, business_id, document_id):
        with engine.begin() as connection:
            _owned_document(connection, owner_id, business_id, document_id)
            connection.execute(documents.update().where(documents.c.id == document_id)
                .values(status="failed", error_code="deletion_pending", error_message="Removal is pending. Use Remove again to finish.", updated_at=func.now()))
        # No unlink happens until the removal intent has successfully committed.
        try:
            _remove_file_and_empty_dirs(document_file_path(owner_id, business_id, document_id))
        except OSError:
            raise DocumentRejectError(503, "deletion_pending", "Removal is pending. Use Remove again to finish.") from None
        with engine.begin() as connection:
            connection.execute(documents.delete().where(documents.c.id == document_id))
