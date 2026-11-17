import hashlib
import io
import os
import re
import threading
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

import pdfplumber
from pdfminer.pdfdocument import PDFEncryptionError, PDFPasswordIncorrect
from pdfminer.pdfparser import PDFSyntaxError
from pdfplumber.utils.exceptions import PdfminerException
from sqlalchemy import func, select
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from app.models import businesses, documents, owners
from app.schemas import DocumentSummary

MAX_PDF_BYTES = 20 * 1024 * 1024  # 20 MB
MAX_PDF_PAGES = 50
READ_CHUNK_BYTES = 64 * 1024
ALLOWED_CONTENT_TYPES = {
    "",
    "application/pdf",
    "application/x-pdf",
    "application/octet-stream",
    "binary/octet-stream",
}

_ACTIVE_JOBS_LOCK = threading.Lock()
_ACTIVE_OWNER_JOBS: dict[UUID, UUID] = {}


class DocumentRejectError(Exception):
    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def get_storage_root() -> Path:
    configured = os.getenv("DOCUMENT_STORAGE_DIR", "").strip()
    if configured:
        return Path(configured).resolve()
    return (Path(__file__).resolve().parents[1] / ".storage" / "documents").resolve()


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


def inspect_pdf_bytes(data: bytes) -> tuple[int, int]:
    has_encrypt_marker = bool(re.search(rb"/Encrypt\b", data))
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            if has_encrypt_marker or getattr(pdf.doc, "encryption", None) is not None:
                raise DocumentRejectError(
                    422,
                    "encrypted_pdf",
                    "Password-protected or encrypted PDFs are not supported.",
                )
            page_count = len(pdf.pages)
            if page_count < 1:
                raise DocumentRejectError(
                    422,
                    "empty_pdf_pages",
                    "PDF contains no readable pages.",
                )
            if page_count > MAX_PDF_PAGES:
                raise DocumentRejectError(
                    422,
                    "too_many_pages",
                    f"PDF has {page_count} pages, exceeding the 50-page limit.",
                )
            extracted_chars = 0
            for page in pdf.pages:
                text = page.extract_text() or ""
                extracted_chars += len(re.sub(r"\s+", "", text))
    except DocumentRejectError:
        raise
    except (PDFPasswordIncorrect, PDFEncryptionError):
        raise DocumentRejectError(
            422,
            "encrypted_pdf",
            "Password-protected or encrypted PDFs are not supported.",
        ) from None
    except (PDFSyntaxError, PdfminerException, Exception) as exc:
        msg = str(exc).lower()
        if has_encrypt_marker or "password" in msg or "encrypt" in msg:
            raise DocumentRejectError(
                422,
                "encrypted_pdf",
                "Password-protected or encrypted PDFs are not supported.",
            ) from None
        raise DocumentRejectError(
            422,
            "corrupted_pdf",
            "PDF could not be parsed. Check that the file is not corrupted or encrypted.",
        ) from None

    if extracted_chars == 0:
        raise DocumentRejectError(
            422,
            "scanned_only_pdf",
            "Scanned or image-only PDFs without selectable digital text are not supported.",
        )
    return page_count, extracted_chars


def _acquire_active_job(owner_id: UUID, document_id: UUID) -> None:
    with _ACTIVE_JOBS_LOCK:
        if owner_id in _ACTIVE_OWNER_JOBS:
            raise DocumentRejectError(
                409,
                "active_job_exists",
                "Another PDF processing job is already active; wait for it to finish or retry it.",
            )
        _ACTIVE_OWNER_JOBS[owner_id] = document_id


def _release_active_job(owner_id: UUID, document_id: UUID) -> None:
    with _ACTIVE_JOBS_LOCK:
        if _ACTIVE_OWNER_JOBS.get(owner_id) == document_id:
            _ACTIVE_OWNER_JOBS.pop(owner_id, None)


def _active_job_id(owner_id: UUID) -> UUID | None:
    with _ACTIVE_JOBS_LOCK:
        return _ACTIVE_OWNER_JOBS.get(owner_id)


def _ensure_owned_business(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> None:
    row = (
        connection.execute(
            select(businesses.c.id).where(
                businesses.c.id == business_id, businesses.c.owner_id == owner_id
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise LookupError("Business not found")


def _lock_owner(connection: Connection, owner_id: UUID) -> None:
    connection.execute(
        select(owners.c.id).where(owners.c.id == owner_id).with_for_update()
    )


def _row_to_summary(row) -> DocumentSummary:
    return DocumentSummary(
        id=row["id"],
        business_id=row["business_id"],
        filename=row["filename"],
        sha256=row["sha256"],
        byte_size=row["byte_size"],
        page_count=row["page_count"],
        extracted_char_count=row["extracted_char_count"],
        status=row["status"],
        error_code=row["error_code"],
        error_message=row["error_message"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def reconcile_interrupted_documents(
    connection: Connection, owner_id: UUID, business_id: UUID | None = None
) -> None:
    active_doc_id = _active_job_id(owner_id)
    stmt = select(documents).where(
        documents.c.owner_id == owner_id,
        documents.c.status == "processing",
    )
    if business_id is not None:
        stmt = stmt.where(documents.c.business_id == business_id)
    stale_rows = connection.execute(stmt).mappings().all()
    for row in stale_rows:
        if active_doc_id is not None and row["id"] == active_doc_id:
            continue
        connection.execute(
            documents.update()
            .where(documents.c.id == row["id"], documents.c.status == "processing")
            .values(
                status="failed",
                error_code="interrupted_job",
                error_message="Processing was interrupted before completion. Retry processing to continue.",
                updated_at=func.now(),
            )
        )


def list_documents(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> list[DocumentSummary]:
    _ensure_owned_business(connection, owner_id, business_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    rows = (
        connection.execute(
            select(documents)
            .where(
                documents.c.business_id == business_id,
                documents.c.owner_id == owner_id,
            )
            .order_by(documents.c.created_at.desc(), documents.c.id.desc())
        )
        .mappings()
        .all()
    )
    return [_row_to_summary(row) for row in rows]


def _write_pdf_atomically(target: Path, data: bytes) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.with_suffix(".tmp")
    try:
        tmp_path.write_bytes(data)
        os.replace(tmp_path, target)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _remove_file_and_empty_dirs(target: Path) -> None:
    target.unlink(missing_ok=True)
    root = get_storage_root()
    parent = target.parent
    while parent != root and root in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def upload_and_process_document(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    filename: str | None,
    content_type: str | None,
    stream: BinaryIO,
) -> DocumentSummary:
    _ensure_owned_business(connection, owner_id, business_id)
    _lock_owner(connection, owner_id)
    reconcile_interrupted_documents(connection, owner_id)

    existing_active = (
        connection.execute(
            select(documents.c.id).where(
                documents.c.owner_id == owner_id,
                documents.c.status == "processing",
            )
        )
        .mappings()
        .one_or_none()
    )
    if existing_active is not None:
        raise DocumentRejectError(
            409,
            "active_job_exists",
            "Another PDF processing job is already active; wait for it to finish or retry it.",
        )

    clean_filename = sanitize_pdf_filename(filename)
    data = read_bounded_upload(stream, content_type)
    document_id = uuid4()
    _acquire_active_job(owner_id, document_id)
    target_path = document_file_path(owner_id, business_id, document_id)
    try:
        page_count, extracted_chars = inspect_pdf_bytes(data)
        sha256_hex = hashlib.sha256(data).hexdigest()
        _write_pdf_atomically(target_path, data)
        try:
            connection.execute(
                documents.insert().values(
                    id=document_id,
                    business_id=business_id,
                    owner_id=owner_id,
                    filename=clean_filename,
                    sha256=sha256_hex,
                    byte_size=len(data),
                    page_count=None,
                    extracted_char_count=None,
                    status="processing",
                    error_code=None,
                    error_message=None,
                )
            )
            row = (
                connection.execute(
                    documents.update()
                    .where(documents.c.id == document_id)
                    .values(
                        page_count=page_count,
                        extracted_char_count=extracted_chars,
                        status="ready",
                        error_code=None,
                        error_message=None,
                        updated_at=func.now(),
                    )
                    .returning(documents)
                )
                .mappings()
                .one()
            )
            return _row_to_summary(row)
        except IntegrityError:
            _remove_file_and_empty_dirs(target_path)
            raise DocumentRejectError(
                409,
                "active_job_exists",
                "Another PDF processing job is already active; wait for it to finish or retry it.",
            ) from None
        except Exception:
            _remove_file_and_empty_dirs(target_path)
            raise
    finally:
        _release_active_job(owner_id, document_id)


def retry_document_processing(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    document_id: UUID,
) -> DocumentSummary:
    _ensure_owned_business(connection, owner_id, business_id)
    _lock_owner(connection, owner_id)
    reconcile_interrupted_documents(connection, owner_id)

    row = (
        connection.execute(
            select(documents)
            .where(
                documents.c.id == document_id,
                documents.c.business_id == business_id,
                documents.c.owner_id == owner_id,
            )
            .with_for_update()
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise LookupError("Document not found")
    if row["status"] == "ready":
        raise DocumentRejectError(
            409,
            "already_ready",
            "Document processing has already completed.",
        )

    other_active = (
        connection.execute(
            select(documents.c.id).where(
                documents.c.owner_id == owner_id,
                documents.c.status == "processing",
                documents.c.id != document_id,
            )
        )
        .mappings()
        .one_or_none()
    )
    if other_active is not None:
        raise DocumentRejectError(
            409,
            "active_job_exists",
            "Another PDF processing job is already active; wait for it to finish or retry it.",
        )

    _acquire_active_job(owner_id, document_id)
    try:
        connection.execute(
            documents.update()
            .where(documents.c.id == document_id)
            .values(
                status="processing",
                error_code=None,
                error_message=None,
                updated_at=func.now(),
            )
        )
        target_path = document_file_path(owner_id, business_id, document_id)
        if not target_path.is_file():
            failed_row = (
                connection.execute(
                    documents.update()
                    .where(documents.c.id == document_id)
                    .values(
                        status="failed",
                        error_code="missing_storage_file",
                        error_message="Stored PDF file is unavailable; delete and re-upload the document.",
                        updated_at=func.now(),
                    )
                    .returning(documents)
                )
                .mappings()
                .one()
            )
            return _row_to_summary(failed_row)

        data = target_path.read_bytes()
        try:
            page_count, extracted_chars = inspect_pdf_bytes(data)
        except DocumentRejectError as exc:
            failed_row = (
                connection.execute(
                    documents.update()
                    .where(documents.c.id == document_id)
                    .values(
                        status="failed",
                        error_code=exc.code,
                        error_message=exc.message,
                        updated_at=func.now(),
                    )
                    .returning(documents)
                )
                .mappings()
                .one()
            )
            return _row_to_summary(failed_row)

        ready_row = (
            connection.execute(
                documents.update()
                .where(documents.c.id == document_id)
                .values(
                    page_count=page_count,
                    extracted_char_count=extracted_chars,
                    status="ready",
                    error_code=None,
                    error_message=None,
                    updated_at=func.now(),
                )
                .returning(documents)
            )
            .mappings()
            .one()
        )
        return _row_to_summary(ready_row)
    finally:
        _release_active_job(owner_id, document_id)


def get_document_file(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    document_id: UUID,
) -> tuple[DocumentSummary, Path]:
    _ensure_owned_business(connection, owner_id, business_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    row = (
        connection.execute(
            select(documents).where(
                documents.c.id == document_id,
                documents.c.business_id == business_id,
                documents.c.owner_id == owner_id,
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise LookupError("Document not found")
    target_path = document_file_path(owner_id, business_id, document_id)
    if not target_path.is_file():
        raise LookupError("Document file not found")
    return _row_to_summary(row), target_path


def delete_document(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    document_id: UUID,
) -> None:
    _ensure_owned_business(connection, owner_id, business_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    row = (
        connection.execute(
            select(documents)
            .where(
                documents.c.id == document_id,
                documents.c.business_id == business_id,
                documents.c.owner_id == owner_id,
            )
            .with_for_update()
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise LookupError("Document not found")
    if row["status"] == "processing":
        raise DocumentRejectError(
            409,
            "active_job_exists",
            "Cannot delete a document while processing is active.",
        )
    connection.execute(documents.delete().where(documents.c.id == document_id))
    target_path = document_file_path(owner_id, business_id, document_id)
    _remove_file_and_empty_dirs(target_path)
