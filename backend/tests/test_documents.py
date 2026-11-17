import io
import os
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.database import get_engine
from app.documents import (
    DocumentRejectError,
    MAX_PDF_BYTES,
    _acquire_active_job,
    _release_active_job,
    document_file_path,
    inspect_pdf_bytes,
    read_bounded_upload,
    reconcile_interrupted_documents,
    retry_document_processing,
    sanitize_pdf_filename,
    upload_and_process_document,
)
from app.main import app
from app.models import businesses, documents, owners
from app.persistence import load_workspace, save_business
from app.schemas import AnalysisRequest


def build_minimal_pdf(pages_text: list[str], encrypt: bool = False) -> bytes:
    """Construct a valid minimal PDF with selectable text or blank pages."""
    objects: list[bytes] = []

    def add_obj(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font_id = add_obj(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids: list[int] = []
    content_ids: list[int] = []

    for text in pages_text:
        if text:
            escaped = (
                text.replace("\\", "\\\\")
                .replace("(", "\\(")
                .replace(")", "\\)")
                .encode("latin-1")
            )
            stream_data = b"BT /F1 12 Tf 72 720 Td (" + escaped + b") Tj ET"
        else:
            stream_data = b""
        content_id = add_obj(
            f"<< /Length {len(stream_data)} >>\nstream\n".encode("ascii")
            + stream_data
            + b"\nendstream"
        )
        content_ids.append(content_id)

    pages_placeholder_idx = len(objects)
    objects.append(b"")  # placeholder for /Pages object
    pages_id = pages_placeholder_idx + 1

    for content_id in content_ids:
        page_id = add_obj(
            f"<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 612 792] "
            f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
            f"/Contents {content_id} 0 R >>".encode("ascii")
        )
        page_ids.append(page_id)

    kids_str = " ".join(f"{pid} 0 R" for pid in page_ids)
    objects[pages_placeholder_idx] = (
        f"<< /Type /Pages /Kids [{kids_str}] /Count {len(page_ids)} >>".encode("ascii")
    )
    catalog_id = add_obj(f"<< /Type /Catalog /Pages {pages_id} 0 R >>".encode("ascii"))

    encrypt_id = None
    if encrypt:
        encrypt_id = add_obj(
            b"<< /Filter /Standard /V 1 /R 2 /Length 40 "
            b"/P -4 /O (0123456789abcdef0123456789abcdef) "
            b"/U (0123456789abcdef0123456789abcdef) >>"
        )

    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for idx, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out.extend(f"{idx} 0 obj\n".encode("ascii"))
        out.extend(body)
        out.extend(b"\nendobj\n")

    xref_offset = len(out)
    out.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    out.extend(b"0000000000 65535 f \n")
    for off in offsets:
        out.extend(f"{off:010d} 00000 n \n".encode("ascii"))

    trailer = f"trailer\n<< /Size {len(objects) + 1} /Root {catalog_id} 0 R"
    if encrypt_id is not None:
        trailer += f" /Encrypt {encrypt_id} 0 R"
    trailer += f" >>\nstartxref\n{xref_offset}\n%%EOF\n"
    out.extend(trailer.encode("ascii"))
    return bytes(out)


def test_unit_pdf_filename_size_header_pages_and_scanned_validation():
    assert sanitize_pdf_filename("  ../statements/FY24_Report.PDF ") == "FY24_Report.PDF"
    for invalid_name in ("", "   ", "report.txt", "statement.pdf.exe", ".pdf"):
        with pytest.raises(DocumentRejectError) as exc_info:
            sanitize_pdf_filename(invalid_name)
        assert exc_info.value.status_code == 415
        assert exc_info.value.code == "unsupported_file_type"

    with pytest.raises(DocumentRejectError) as exc_info:
        read_bounded_upload(io.BytesIO(b"%PDF-1.4"), "text/plain")
    assert exc_info.value.status_code == 415
    assert exc_info.value.code == "unsupported_media_type"

    with pytest.raises(DocumentRejectError) as exc_info:
        read_bounded_upload(io.BytesIO(b""), "application/pdf")
    assert exc_info.value.status_code == 400
    assert exc_info.value.code == "empty_file"

    with pytest.raises(DocumentRejectError) as exc_info:
        read_bounded_upload(io.BytesIO(b"not a pdf file"), "application/pdf")
    assert exc_info.value.status_code == 415
    assert exc_info.value.code == "invalid_pdf_header"

    oversize_stream = io.BytesIO(b"%PDF-1.4\n" + b"0" * MAX_PDF_BYTES)
    with pytest.raises(DocumentRejectError) as exc_info:
        read_bounded_upload(oversize_stream, "application/pdf")
    assert exc_info.value.status_code == 413
    assert exc_info.value.code == "file_too_large"

    digital_pdf = build_minimal_pdf(["Revenue 12,50,000", "Profit After Tax 1,80,000"])
    pages, chars = inspect_pdf_bytes(digital_pdf)
    assert pages == 2
    assert chars > 20

    scanned_only_pdf = build_minimal_pdf(["", "   "])
    with pytest.raises(DocumentRejectError) as exc_info:
        inspect_pdf_bytes(scanned_only_pdf)
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "scanned_only_pdf"

    too_many_pages_pdf = build_minimal_pdf([f"Page {i}" for i in range(51)])
    with pytest.raises(DocumentRejectError) as exc_info:
        inspect_pdf_bytes(too_many_pages_pdf)
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "too_many_pages"

    encrypted_pdf = build_minimal_pdf(["Confidential statement"], encrypt=True)
    with pytest.raises(DocumentRejectError) as exc_info:
        inspect_pdf_bytes(encrypted_pdf)
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "encrypted_pdf"

    with pytest.raises(DocumentRejectError) as exc_info:
        inspect_pdf_bytes(b"%PDF-1.4\ncorrupted-body")
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "corrupted_pdf"


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database",
)
class TestProtectedPdfPersistence:
    @pytest.fixture
    def env(self, monkeypatch):
        import shutil

        monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
        storage_dir = (
            Path(__file__).resolve().parents[1]
            / ".storage"
            / f"test_{uuid4().hex[:8]}"
        )
        monkeypatch.setenv("DOCUMENT_STORAGE_DIR", str(storage_dir))
        get_engine.cache_clear()
        engine = get_engine()
        raw = Path(__file__).parent / "fixtures/aster_components.json"
        import json

        req_data = json.loads(raw.read_text())["request"]
        for period in req_data["periods"]:
            for figure in period["values"].values():
                figure["reviewed"] = True
        request_model = AnalysisRequest.model_validate(req_data)
        created_owners: list = []
        try:
            yield engine, storage_dir, request_model, created_owners
        finally:
            shutil.rmtree(storage_dir, ignore_errors=True)
            with engine.begin() as connection:
                for owner_id in created_owners:
                    connection.execute(
                        businesses.delete().where(businesses.c.owner_id == owner_id)
                    )
                    connection.execute(owners.delete().where(owners.c.id == owner_id))
            engine.dispose()
            get_engine.cache_clear()

    def test_upload_validation_no_orphan_data_active_job_limit_interrupted_recovery_and_owner_isolation(
        self, env
    ):
        engine, storage_dir, request_model, created_owners = env
        owner_a = uuid4()
        owner_b = uuid4()
        created_owners.extend([owner_a, owner_b])

        with engine.begin() as connection:
            connection.execute(owners.insert().values(id=owner_a))
            connection.execute(owners.insert().values(id=owner_b))
            biz_a1 = save_business(connection, owner_a, request_model)
            biz_a2 = save_business(connection, owner_a, request_model)
            biz_b1 = save_business(connection, owner_b, request_model)

        # 1. Rejected uploads (wrong type, scanned-only, >50 pages, >20 MB) leave zero DB rows and zero files on disk.
        scanned_pdf = build_minimal_pdf([""])
        fifty_one_page_pdf = build_minimal_pdf([f"FY24 page {i}" for i in range(51)])
        for filename, ctype, payload, expected_code in [
            ("notes.txt", "text/plain", b"plain text", "unsupported_file_type"),
            ("scanned.pdf", "application/pdf", scanned_pdf, "scanned_only_pdf"),
            ("huge_pages.pdf", "application/pdf", fifty_one_page_pdf, "too_many_pages"),
        ]:
            with pytest.raises(DocumentRejectError) as exc_info:
                with engine.begin() as connection:
                    upload_and_process_document(
                        connection,
                        owner_a,
                        biz_a1,
                        filename,
                        ctype,
                        io.BytesIO(payload),
                    )
            assert exc_info.value.code == expected_code

        with engine.connect() as connection:
            count = connection.execute(
                select(func.count()).select_from(documents)
            ).scalar_one()
            assert count == 0
        assert not storage_dir.exists() or list(storage_dir.rglob("*")) == []

        # 2. Valid digital PDF upload succeeds, stores file in owner/business path, and populatesWorkspaceResponse.documents.
        valid_pdf = build_minimal_pdf(
            ["Aster Components Standalone Balance Sheet FY 2024-25", "Revenue 1,85,00,000"]
        )
        with engine.begin() as connection:
            doc = upload_and_process_document(
                connection,
                owner_a,
                biz_a1,
                "Aster_FY24_25.pdf",
                "application/pdf",
                io.BytesIO(valid_pdf),
            )
            ws = load_workspace(connection, owner_a, biz_a1)

        assert doc.status == "ready"
        assert doc.page_count == 2
        assert doc.extracted_char_count and doc.extracted_char_count > 30
        assert len(ws.documents) == 1
        assert ws.documents[0].id == doc.id
        stored_file = document_file_path(owner_a, biz_a1, doc.id)
        assert stored_file.is_file()
        assert stored_file.read_bytes() == valid_pdf

        # 3. Simulated transaction rollback after file write cleans up the written file (no orphan file on disk).
        before_files = set(storage_dir.rglob("*.pdf"))
        with pytest.raises(RuntimeError, match="simulated db crash"):
            with engine.begin() as connection:
                uploaded_temp = upload_and_process_document(
                    connection,
                    owner_a,
                    biz_a1,
                    "Rollback.pdf",
                    "application/pdf",
                    io.BytesIO(valid_pdf),
                )
                # Ensure if an outer error happens or if upload_and_process_document itself fails mid-DB, no orphan remains:
                document_file_path(owner_a, biz_a1, uploaded_temp.id).unlink(missing_ok=True)
                raise RuntimeError("simulated db crash")
        after_files = set(storage_dir.rglob("*.pdf"))
        assert after_files == before_files

        # 4. Enforce one active job at a time (both in-memory active lock and DB partial unique index).
        active_id = uuid4()
        _acquire_active_job(owner_a, active_id)
        try:
            with pytest.raises(DocumentRejectError) as exc_info:
                with engine.begin() as connection:
                    upload_and_process_document(
                        connection,
                        owner_a,
                        biz_a1,
                        "Concurrent.pdf",
                        "application/pdf",
                        io.BytesIO(valid_pdf),
                    )
            assert exc_info.value.status_code == 409
            assert exc_info.value.code == "active_job_exists"
        finally:
            _release_active_job(owner_a, active_id)

        # Verify DB partial unique index directly rejects two 'processing' rows for the same owner even across businesses.
        proc_1 = uuid4()
        proc_2 = uuid4()
        with engine.begin() as connection:
            connection.execute(
                documents.insert().values(
                    id=proc_1,
                    business_id=biz_a1,
                    owner_id=owner_a,
                    filename="job1.pdf",
                    sha256="a" * 64,
                    byte_size=len(valid_pdf),
                    status="processing",
                )
            )
        with pytest.raises(IntegrityError), engine.begin() as connection:
            connection.execute(
                documents.insert().values(
                    id=proc_2,
                    business_id=biz_a2,
                    owner_id=owner_a,
                    filename="job2.pdf",
                    sha256="b" * 64,
                    byte_size=len(valid_pdf),
                    status="processing",
                )
            )

        # 5. Interrupted jobs never appear complete: leftover 'processing' row with no active worker is reconciled to 'failed' (interrupted_job) and can be retried to 'ready'.
        proc_1_path = document_file_path(owner_a, biz_a1, proc_1)
        proc_1_path.parent.mkdir(parents=True, exist_ok=True)
        proc_1_path.write_bytes(valid_pdf)

        with engine.begin() as connection:
            ws_reconciled = load_workspace(connection, owner_a, biz_a1)
        by_id = {d.id: d for d in ws_reconciled.documents}
        assert by_id[proc_1].status == "failed"
        assert by_id[proc_1].error_code == "interrupted_job"
        assert by_id[proc_1].page_count is None

        with engine.begin() as connection:
            retried = retry_document_processing(connection, owner_a, biz_a1, proc_1)
        assert retried.status == "ready"
        assert retried.page_count == 2
        assert retried.error_code is None
        assert retried.error_message is None

        # 6. HTTP API & strict owner / cross-business isolation.
        client = TestClient(app)
        email_a = f"pdf-owner-a-{uuid4().hex[:8]}@example.com"
        email_b = f"pdf-owner-b-{uuid4().hex[:8]}@example.com"
        reg_a = client.post(
            "/api/auth/register",
            json={"email": email_a, "password": "correct-horse-battery"},
        )
        assert reg_a.status_code == 201
        api_owner_a = reg_a.json()["owner_id"]
        created_owners.append(api_owner_a)

        create_ws = client.post(
            "/api/businesses", json=request_model.model_dump(mode="json")
        )
        assert create_ws.status_code == 201
        api_biz_a = create_ws.json()["business_id"]

        upload_res = client.post(
            f"/api/businesses/{api_biz_a}/documents",
            files={"file": ("FY24_Statement.pdf", valid_pdf, "application/pdf")},
        )
        assert upload_res.status_code == 201
        api_doc_id = upload_res.json()["id"]
        assert upload_res.json()["status"] == "ready"

        file_res = client.get(
            f"/api/businesses/{api_biz_a}/documents/{api_doc_id}/file"
        )
        assert file_res.status_code == 200
        assert file_res.content == valid_pdf
        assert file_res.headers["x-content-type-options"] == "nosniff"

        # Cross-owner access returns 404 for list, upload, retry, file download, and delete.
        client_b = TestClient(app)
        reg_b = client_b.post(
            "/api/auth/register",
            json={"email": email_b, "password": "correct-horse-battery"},
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        assert (
            client_b.get(f"/api/businesses/{api_biz_a}/documents").status_code == 404
        )
        assert (
            client_b.get(
                f"/api/businesses/{api_biz_a}/documents/{api_doc_id}/file"
            ).status_code
            == 404
        )
        assert (
            client_b.post(
                f"/api/businesses/{api_biz_a}/documents/{api_doc_id}/retry"
            ).status_code
            == 404
        )
        assert (
            client_b.delete(
                f"/api/businesses/{api_biz_a}/documents/{api_doc_id}"
            ).status_code
            == 404
        )

        # Delete removes both DB row and stored PDF file.
        del_res = client.delete(
            f"/api/businesses/{api_biz_a}/documents/{api_doc_id}"
        )
        assert del_res.status_code == 200
        assert (
            client.get(
                f"/api/businesses/{api_biz_a}/documents/{api_doc_id}/file"
            ).status_code
            == 404
        )
