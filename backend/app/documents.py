import hashlib
import os
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO
from uuid import UUID, uuid4

from sqlalchemy import func, select
from sqlalchemy.engine import Connection, Engine

from app.settings import setting
from app.audit import record_audit_event
from app.models import analysis_runs, businesses, documents, revisions
from app.pdf_processing import (
    PDF_ERRORS, DocumentRejectError, inspect_pdf_file, read_bounded_upload, sanitize_pdf_filename,
)
from app.retrieval import (
    EmbeddingUnavailableError,
    prepare_embedded_chunks,
    replace_document_chunks,
)
from app.schemas.documents import (
    DocumentExtractionResponse,
    DocumentExtractionSnapshot,
    DocumentSummary,
)
from app.schemas.workspaces import WorkspaceDeleteResponse
from app.workspace_access import document_scope, owned_business


SUMMARY_COLUMNS = tuple(documents.c[key] for key in DocumentSummary.model_fields)


def get_storage_root() -> Path:
    configured = setting("DOCUMENT_STORAGE_DIR", "").strip()
    return (
        Path(configured).resolve()
        if configured
        else (Path(__file__).resolve().parents[1] / ".storage" / "documents").resolve()
    )


def document_file_path(owner_id: UUID, business_id: UUID, document_id: UUID) -> Path:
    root = get_storage_root()
    target = (root / str(owner_id) / str(business_id) / f"{document_id}.pdf").resolve()
    if root not in target.parents:
        raise ValueError("Invalid document storage path")
    return target


def _try_job_lock(connection: Connection, owner_id: UUID) -> bool:
    key = int.from_bytes(
        hashlib.blake2b(owner_id.bytes, digest_size=8, person=b"credlens-pdf").digest(),
        signed=True,
    )
    return connection.execute(select(func.pg_try_advisory_xact_lock(key))).scalar_one()


def _mark_interrupted(
    connection: Connection, owner_id: UUID, business_id: UUID | None = None
) -> None:
    stmt = documents.update().where(
        documents.c.owner_id == owner_id, documents.c.status == "processing"
    )
    if business_id is not None:
        stmt = stmt.where(documents.c.business_id == business_id)
    connection.execute(
        stmt.values(
            status="failed",
            page_count=None,
            extracted_char_count=None,
            error_code="interrupted_job",
            error_message="Processing was interrupted. Retry processing to continue.",
            updated_at=func.now(),
        )
    )


def reconcile_interrupted_documents(
    connection: Connection, owner_id: UUID, business_id: UUID | None = None
) -> None:
    stmt = (
        select(documents.c.id)
        .where(documents.c.owner_id == owner_id, documents.c.status == "processing")
        .limit(1)
    )
    if business_id is not None:
        stmt = stmt.where(documents.c.business_id == business_id)
    if connection.execute(stmt).first() is not None and _try_job_lock(
        connection, owner_id
    ):
        _mark_interrupted(connection, owner_id, business_id)


@contextmanager
def _document_job(
    engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID | None = None
):
    # A transaction-scoped advisory lock also works through Neon's transaction pooler.
    with engine.begin() as gate:
        if document_id is None:
            owned_business(gate, owner_id, business_id)
        else:
            _owned_document(gate, owner_id, business_id, document_id)
        if not _try_job_lock(gate, owner_id):
            raise DocumentRejectError(
                409,
                "active_job_exists",
                "Another PDF job is active. Wait for it to finish.",
            )
        with engine.begin() as connection:
            _mark_interrupted(connection, owner_id)
        yield


def _row_to_summary(row) -> DocumentSummary:
    return DocumentSummary(**{key: row[key] for key in DocumentSummary.model_fields})


def _row_to_extraction_response(row) -> DocumentExtractionResponse:
    base = {key: row[key] for key in DocumentSummary.model_fields}
    status = row["status"]
    if status == "processing":
        return DocumentExtractionResponse(
            **base,
            extraction_status="processing",
            extraction_message="PDF processing is in progress. Refresh status after it completes.",
            extraction=None,
        )
    if status == "failed":
        if row["error_code"] == DELETION_PENDING:
            return DocumentExtractionResponse(
                **base,
                extraction_status=DELETION_PENDING,
                extraction_message=row["error_message"],
                extraction=None,
            )
        return DocumentExtractionResponse(
            **base,
            extraction_status="failed",
            extraction_message=row["error_message"],
            extraction=None,
        )
    raw_extraction = row.get("extraction")
    if raw_extraction is None:
        return DocumentExtractionResponse(
            **base,
            extraction_status="not_extracted",
            extraction_message="Document was uploaded before candidate extraction. Run extraction to inspect source pages and candidates.",
            extraction=None,
        )
    if raw_extraction.get("schema_version") == "document-extraction-v1":
        return DocumentExtractionResponse(
            **base,
            extraction_status="refresh_required",
            extraction=None,
            extraction_message="Run extraction again to review candidates with the current rules.",
        )
    snapshot = DocumentExtractionSnapshot.model_validate(raw_extraction)
    usable = sum(
        1
        for candidate in snapshot.candidates
        if candidate.normalized_inr is not None and not candidate.issues
    )
    if snapshot.layout == "unsupported" or not snapshot.candidates:
        message = "No supported financial table layout was recognized. Enter or confirm figures manually."
    elif usable == 0:
        message = "Candidates have unresolved extraction issues. Inspect source rows or enter figures manually."
    else:
        message = None
    return DocumentExtractionResponse(
        **base,
        extraction_status="ready",
        extraction_message=message,
        extraction=snapshot,
    )


def _owned_document(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    document_id: UUID,
    *,
    extraction: bool = False,
):
    owned_business(connection, owner_id, business_id)
    columns = (
        (*SUMMARY_COLUMNS, documents.c.extraction) if extraction else SUMMARY_COLUMNS
    )
    row = (
        connection.execute(
            select(*columns).where(
                documents.c.id == document_id,
                *document_scope(owner_id, business_id),
            )
        )
        .mappings()
        .one_or_none()
    )
    if row is None:
        raise LookupError("Document not found")
    return row


def list_documents(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> list[DocumentSummary]:
    owned_business(connection, owner_id, business_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    rows = connection.execute(
        select(*SUMMARY_COLUMNS)
        .where(*document_scope(owner_id, business_id))
        .order_by(documents.c.created_at.desc(), documents.c.id.desc())
    ).mappings()
    return [_row_to_summary(row) for row in rows]


def _write_pdf_atomically(target: Path, data: bytes) -> None:
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    tmp_path = target.with_suffix(".tmp")
    try:
        with os.fdopen(
            os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
        ) as output:
            output.write(data)
        os.replace(tmp_path, target)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _remove_file_and_empty_dirs(target: Path) -> None:
    target.unlink(missing_ok=True)
    target.with_suffix(".tmp").unlink(missing_ok=True)
    _prune_empty_dirs(target.parent)


def _prune_empty_dirs(parent: Path) -> None:
    root = get_storage_root()
    while parent != root and root in parent.parents:
        try:
            parent.rmdir()
        except OSError:
            break
        parent = parent.parent


def _finish_processing(
    engine: Engine,
    document_id: UUID,
    path: Path,
    *,
    audit_action: str,
) -> DocumentSummary:
    snapshot: DocumentExtractionSnapshot | None = None
    try:
        if not path.is_file():
            raise DocumentRejectError(
                422,
                "missing_storage_file",
                "Stored PDF is unavailable. Remove and re-upload it.",
            )
        snapshot = inspect_pdf_file(path)
        values = dict(
            status="ready",
            page_count=snapshot.page_count,
            extracted_char_count=snapshot.extracted_char_count,
            extraction=snapshot.model_dump(mode="json"),
            error_code=None,
            error_message=None,
        )
    except DocumentRejectError as exc:
        values = dict(
            status="failed",
            page_count=None,
            extracted_char_count=None,
            error_code=exc.code,
            error_message=exc.message,
        )
    embedded_chunks = None
    if values["status"] == "ready" and snapshot is not None:
        with engine.connect() as connection:
            meta = (
                connection.execute(
                    select(
                        documents.c.sha256,
                        documents.c.filename,
                    ).where(documents.c.id == document_id)
                )
                .mappings()
                .one()
            )
        if snapshot.document_sha256 != meta["sha256"]:
            values = dict(
                status="failed",
                page_count=None,
                extracted_char_count=None,
                error_code="corrupted_pdf",
                error_message=PDF_ERRORS["corrupted_pdf"],
            )
        else:
            try:
                embedded_chunks = prepare_embedded_chunks(snapshot, meta["filename"])
            except EmbeddingUnavailableError:
                # Keep deterministic PDF upload/extraction usable if local embedding cache is absent.
                embedded_chunks = []
    with engine.begin() as connection:
        row = (
            connection.execute(
                documents.update()
                .where(documents.c.id == document_id)
                .values(**values, updated_at=func.now())
                .returning(*SUMMARY_COLUMNS, documents.c.owner_id)
            )
            .mappings()
            .one()
        )
        replace_document_chunks(
            connection,
            row["owner_id"],
            row["business_id"],
            document_id,
            embedded_chunks if values["status"] == "ready" and embedded_chunks else [],
        )
        record_audit_event(
            connection,
            row["owner_id"],
            audit_action,
            resource_id=document_id,
            business_id=row["business_id"],
            details={"status": values["status"]},
        )
        summary = _row_to_summary(row)
    return summary


def upload_and_process_document(
    engine: Engine,
    owner_id: UUID,
    business_id: UUID,
    filename: str | None,
    content_type: str | None,
    stream: BinaryIO,
) -> DocumentSummary:
    with _document_job(engine, owner_id, business_id):
        name = sanitize_pdf_filename(filename)
        data = read_bounded_upload(stream, content_type)
        document_id = uuid4()
        path = document_file_path(owner_id, business_id, document_id)
        # Commit metadata before writing: a crash can leave a recoverable row, never an untracked file.
        with engine.begin() as connection:
            connection.execute(
                documents.insert().values(
                    id=document_id,
                    owner_id=owner_id,
                    business_id=business_id,
                    filename=name,
                    sha256=hashlib.sha256(data).hexdigest(),
                    byte_size=len(data),
                    status="processing",
                )
            )
        try:
            _write_pdf_atomically(path, data)
        except OSError:
            with engine.begin() as connection:
                row = (
                    connection.execute(
                        documents.update()
                        .where(documents.c.id == document_id)
                        .values(
                            status="failed",
                            error_code="storage_unavailable",
                            error_message="PDF storage failed. Remove and re-upload the file.",
                            updated_at=func.now(),
                        )
                        .returning(*SUMMARY_COLUMNS)
                    )
                    .mappings()
                    .one()
                )
                summary = _row_to_summary(row)
                record_audit_event(
                    connection,
                    owner_id,
                    "document_uploaded",
                    resource_id=document_id,
                    business_id=business_id,
                    details={"status": "failed"},
                )
            return summary
        return _finish_processing(
            engine, document_id, path, audit_action="document_uploaded"
        )


def _mark_processing(connection: Connection, document_id: UUID) -> None:
    connection.execute(
        documents.update().where(documents.c.id == document_id).values(
            status="processing",
            page_count=None,
            extracted_char_count=None,
            error_code=None,
            error_message=None,
            updated_at=func.now(),
        )
    )


def retry_document_processing(
    engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID
) -> DocumentSummary:
    with _document_job(engine, owner_id, business_id, document_id):
        with engine.begin() as connection:
            row = _owned_document(connection, owner_id, business_id, document_id)
            if row["status"] == "ready" or row["error_code"] == DELETION_PENDING:
                raise DocumentRejectError(
                    409,
                    "not_retryable",
                    "Document is ready or pending removal; refresh its status.",
                )
            _mark_processing(connection, document_id)
        return _finish_processing(
            engine,
            document_id,
            document_file_path(owner_id, business_id, document_id),
            audit_action="document_retried",
        )


def get_document_extraction(
    connection: Connection, owner_id: UUID, business_id: UUID, document_id: UUID
) -> DocumentExtractionResponse:
    _owned_document(connection, owner_id, business_id, document_id)
    reconcile_interrupted_documents(connection, owner_id, business_id)
    row = _owned_document(
        connection, owner_id, business_id, document_id, extraction=True
    )
    return _row_to_extraction_response(row)


def extract_ready_document(
    engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID
) -> DocumentExtractionResponse:
    with _document_job(engine, owner_id, business_id, document_id):
        with engine.begin() as connection:
            row = _owned_document(connection, owner_id, business_id, document_id)
            if row["status"] != "ready":
                raise DocumentRejectError(
                    409,
                    "document_not_ready",
                    "Document must be ready before running extraction; retry failed processing first.",
                )
            _mark_processing(connection, document_id)
        _finish_processing(
            engine,
            document_id,
            document_file_path(owner_id, business_id, document_id),
            audit_action="document_extracted",
        )
        with engine.begin() as connection:
            row = _owned_document(
                connection, owner_id, business_id, document_id, extraction=True
            )
            return _row_to_extraction_response(row)


def get_document_file(
    connection: Connection, owner_id: UUID, business_id: UUID, document_id: UUID
) -> tuple[DocumentSummary, Path]:
    row = _owned_document(connection, owner_id, business_id, document_id)
    path = document_file_path(owner_id, business_id, document_id)
    if row["status"] != "ready" or not path.is_file():
        raise LookupError("Document file not ready or unavailable")
    return _row_to_summary(row), path


DELETION_PENDING = "deletion_pending"
DOCUMENT_REMOVAL_PENDING = "Removal is pending. Use Remove again to finish."
WORKSPACE_REMOVAL_PENDING = "Workspace removal is pending. Retry Delete workspace to finish."


def _mark_deletion_pending(connection: Connection, filters, message: str) -> None:
    connection.execute(
        documents.update().where(*filters).values(
            status="failed", error_code=DELETION_PENDING,
            error_message=message, updated_at=func.now(),
        )
    )


def delete_document(
    engine: Engine, owner_id: UUID, business_id: UUID, document_id: UUID
) -> None:
    with _document_job(engine, owner_id, business_id, document_id):
        with engine.begin() as connection:
            _owned_document(connection, owner_id, business_id, document_id)
            _mark_deletion_pending(
                connection, (documents.c.id == document_id,), DOCUMENT_REMOVAL_PENDING
            )
        # An unlink is only safe once a rollback can no longer expose the PDF as ready.
        try:
            _remove_file_and_empty_dirs(
                document_file_path(owner_id, business_id, document_id)
            )
        except OSError:
            raise DocumentRejectError(
                503, DELETION_PENDING, DOCUMENT_REMOVAL_PENDING,
            ) from None
        with engine.begin() as connection:
            connection.execute(documents.delete().where(documents.c.id == document_id))
            record_audit_event(
                connection,
                owner_id,
                "document_deleted",
                resource_id=document_id,
                business_id=business_id,
            )


WORKSPACE_CHAT_NOTE = (
    "Q&A turns are request-scoped and are not persisted in the database; "
    "any in-session answers clear immediately."
)
WORKSPACE_BACKUP_NOTICE = (
    "Active workspace figures, revisions, uploaded PDFs, extracted snapshots, "
    "chunks/embeddings, analysis runs, and reports have been deleted. External "
    "PostgreSQL host backups or point-in-time recovery snapshots follow host "
    "retention policies and are not immediately purged."
)


def delete_workspace(
    engine: Engine, owner_id: UUID, business_id: UUID
) -> WorkspaceDeleteResponse:
    """Staged deletion of an owned workspace, all local PDFs/temp files, and cascaded DB data."""
    with _document_job(engine, owner_id, business_id):
        with engine.begin() as connection:
            owned_business(connection, owner_id, business_id)
            doc_ids = list(
                connection.execute(
                    select(documents.c.id).where(
                        *document_scope(owner_id, business_id),
                    )
                ).scalars()
            )
            if doc_ids:
                _mark_deletion_pending(
                    connection, document_scope(owner_id, business_id), WORKSPACE_REMOVAL_PENDING
                )
        try:
            for doc_id in doc_ids:
                _remove_file_and_empty_dirs(
                    document_file_path(owner_id, business_id, doc_id)
                )
            biz_dir = get_storage_root() / str(owner_id) / str(business_id)
            if biz_dir.is_dir():
                for child in biz_dir.iterdir():
                    if child.is_file() or child.is_symlink():
                        child.unlink(missing_ok=True)
                _prune_empty_dirs(biz_dir)
        except OSError:
            raise DocumentRejectError(
                503, DELETION_PENDING, WORKSPACE_REMOVAL_PENDING,
            ) from None

        with engine.begin() as connection:
            owned_business(connection, owner_id, business_id, for_update=True)
            runs_count = connection.scalar(
                select(func.count()).select_from(analysis_runs)
                .where(analysis_runs.c.business_id == business_id)
            )
            revisions_count = connection.scalar(
                select(func.count()).select_from(revisions)
                .where(revisions.c.business_id == business_id)
            )
            connection.execute(
                businesses.delete()
                .where(businesses.c.id == business_id, businesses.c.owner_id == owner_id)
            )
            record_audit_event(
                connection,
                owner_id,
                "workspace_deleted",
                resource_id=business_id,
                business_id=business_id,
                details={
                    "documents_removed": len(doc_ids),
                    "runs_removed": int(runs_count),
                    "revisions_removed": int(revisions_count),
                },
            )
        return WorkspaceDeleteResponse(
            business_id=business_id,
            documents_removed=len(doc_ids),
            runs_removed=int(runs_count),
            revisions_removed=int(revisions_count),
            chat_note=WORKSPACE_CHAT_NOTE,
            backup_notice=WORKSPACE_BACKUP_NOTICE,
        )
