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
    delete_document,
    get_document_file,
    list_documents,
    document_file_path,
    inspect_pdf_bytes,
    read_bounded_upload,
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

    @pytest.fixture
    def workspace(self, env):
        engine, storage, model, created = env
        owner, other = uuid4(), uuid4()
        created.extend([owner, other])
        with engine.begin() as c:
            c.execute(owners.insert(), [{"id": owner}, {"id": other}])
            business = save_business(c, owner, model)
            second = save_business(c, owner, model)
        return engine, storage, owner, other, business, second

    def test_validation_durable_processing_and_isolation(self, workspace, monkeypatch):
        import app.documents as service
        engine, storage, owner, other, business, second = workspace
        payload = build_minimal_pdf(["Revenue 120000"])
        with pytest.raises(DocumentRejectError):
            upload_and_process_document(engine, owner, business, "bad.txt", "text/plain", io.BytesIO(payload))
        assert not list(storage.rglob("*.pdf"))
        original = service.inspect_pdf_file

        def observe(path):
            with engine.begin() as c:
                visible = list_documents(c, owner, business)
            assert len(visible) == 1 and visible[0].status == "processing"
            with pytest.raises(DocumentRejectError, match="Another PDF job"):
                upload_and_process_document(engine, owner, second, "busy.pdf", "application/pdf", io.BytesIO(payload))
            # Unknown/cross-business documents stay 404 even while this owner is busy.
            with pytest.raises(LookupError):
                retry_document_processing(engine, owner, second, visible[0].id)
            with pytest.raises(LookupError):
                delete_document(engine, owner, business, uuid4())
            return original(path)

        with monkeypatch.context() as patch:
            patch.setattr(service, "inspect_pdf_file", observe)
            doc = upload_and_process_document(engine, owner, business, "good.pdf", "application/pdf", io.BytesIO(payload))
        assert doc.status == "ready" and doc.page_count == 1
        path = document_file_path(owner, business, doc.id)
        assert path.read_bytes() == payload
        with engine.begin() as c:
            assert load_workspace(c, owner, business).documents[0].id == doc.id
            for bad_owner, bad_business in [(other, business), (owner, second)]:
                with pytest.raises(LookupError):
                    get_document_file(c, bad_owner, bad_business, doc.id)
        for content, code in [(build_minimal_pdf([""]), "scanned_only_pdf"), (build_minimal_pdf(["x"] * 51), "too_many_pages")]:
            failed = upload_and_process_document(engine, owner, business, "failed.pdf", "application/pdf", io.BytesIO(content))
            assert failed.status == "failed" and failed.error_code == code
            assert document_file_path(owner, business, failed.id).exists()
            with engine.begin() as c, pytest.raises(LookupError):
                get_document_file(c, owner, business, failed.id)
            delete_document(engine, owner, business, failed.id)
        delete_document(engine, owner, business, doc.id)
        assert not path.exists()

    def test_commit_failures_leave_recoverable_files(self, workspace, monkeypatch):
        from contextlib import contextmanager
        engine, storage, owner, _, business, _ = workspace
        payload = build_minimal_pdf(["Revenue 120000"])
        from sqlalchemy import event

        @contextmanager
        def fail_commit(operation, status=None, error_code=None):
            def after_execute(c, cursor, statement, parameters, context, many):
                if (statement.startswith(operation)
                        and (status is None or parameters.get("status") == status)
                        and (error_code is None or parameters.get("error_code") == error_code)):
                    c.info["document_test_fail_commit"] = True
            def on_commit(c):
                if c.info.pop("document_test_fail_commit", False):
                    raise RuntimeError("simulated commit failure")
            event.listen(engine, "after_cursor_execute", after_execute)
            event.listen(engine, "commit", on_commit)
            try:
                yield
            finally:
                event.remove(engine, "commit", on_commit)
                event.remove(engine, "after_cursor_execute", after_execute)

        # Initial metadata failure occurs before any file is written.
        with fail_commit("INSERT INTO documents"), pytest.raises(RuntimeError, match="simulated commit failure"):
            upload_and_process_document(engine, owner, business, "fail.pdf", "application/pdf", io.BytesIO(payload))
        assert not list(storage.rglob("*.pdf"))
        with engine.connect() as c:
            assert c.execute(select(func.count()).select_from(documents)).scalar_one() == 0
        # Final status failure leaves committed processing metadata and its file.
        with fail_commit("UPDATE documents", "ready"), pytest.raises(RuntimeError, match="simulated commit failure"):
            upload_and_process_document(engine, owner, business, "recover.pdf", "application/pdf", io.BytesIO(payload))
        with engine.begin() as c:
            failed = list_documents(c, owner, business)[0]
        assert failed.error_code == "interrupted_job"
        path = document_file_path(owner, business, failed.id)
        assert path.exists()
        ready = retry_document_processing(engine, owner, business, failed.id)
        assert ready.status == "ready"
        # Failed removal-intent commit cannot delete a retained PDF.
        with fail_commit("UPDATE documents", "failed", "deletion_pending"), pytest.raises(RuntimeError, match="simulated commit failure"):
            delete_document(engine, owner, business, ready.id)
        with engine.begin() as c:
            assert get_document_file(c, owner, business, ready.id)[1].read_bytes() == payload
        # Failed final deletion leaves a durable pending-removal record.
        with fail_commit("DELETE FROM documents"), pytest.raises(RuntimeError, match="simulated commit failure"):
            delete_document(engine, owner, business, ready.id)
        assert not path.exists()
        with engine.begin() as c:
            assert list_documents(c, owner, business)[0].error_code == "deletion_pending"
        with pytest.raises(DocumentRejectError) as exc:
            retry_document_processing(engine, owner, business, ready.id)
        assert exc.value.code == "not_retryable"
        delete_document(engine, owner, business, ready.id)
        with engine.begin() as c:
            assert list_documents(c, owner, business) == []

    def test_storage_failure_and_failed_unlink_can_be_completed(self, workspace, monkeypatch):
        import app.documents as service
        engine, _, owner, _, business, _ = workspace
        def disk_full(path, data):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.with_suffix(".tmp").write_bytes(data[:10])
            raise OSError("disk full")
        with monkeypatch.context() as patch:
            patch.setattr(service, "_write_pdf_atomically", disk_full)
            failed = upload_and_process_document(engine, owner, business, "full.pdf", "application/pdf", io.BytesIO(build_minimal_pdf(["Revenue"])))
        assert failed.status == "failed" and failed.error_code == "storage_unavailable"
        temporary = document_file_path(owner, business, failed.id).with_suffix(".tmp")
        assert temporary.exists()
        delete_document(engine, owner, business, failed.id)
        assert not temporary.exists()
        doc = upload_and_process_document(engine, owner, business, "good.pdf", "application/pdf", io.BytesIO(build_minimal_pdf(["Revenue"])))
        with monkeypatch.context() as patch:
            def denied(path):
                raise PermissionError("locked")
            patch.setattr(service, "_remove_file_and_empty_dirs", denied)
            with pytest.raises(DocumentRejectError) as exc:
                delete_document(engine, owner, business, doc.id)
        assert exc.value.code == "deletion_pending"
        path = document_file_path(owner, business, doc.id)
        assert path.exists()
        with engine.begin() as c:
            assert list_documents(c, owner, business)[0].error_code == "deletion_pending"
            with pytest.raises(LookupError):
                get_document_file(c, owner, business, doc.id)
        delete_document(engine, owner, business, doc.id)
        assert not path.exists()

    @pytest.mark.parametrize("stage", ["inspect_pdf_file", "_write_pdf_atomically"])
    def test_real_process_death_is_retryable(self, workspace, tmp_path, stage):
        import subprocess
        import sys
        engine, _, owner, _, business, _ = workspace
        source = tmp_path / "source.pdf"
        source.write_bytes(build_minimal_pdf(["Revenue 120000"]))
        script = """
import io, os, sys
from uuid import UUID
import app.documents as service
from app.database import get_engine
def crash(*args):
    os._exit(23)
setattr(service, sys.argv[4], crash)
service.upload_and_process_document(get_engine(), UUID(sys.argv[1]), UUID(sys.argv[2]), "crash.pdf", "application/pdf", io.BytesIO(open(sys.argv[3], "rb").read()))
"""
        result = subprocess.run([sys.executable, "-c", script, str(owner), str(business), str(source), stage], timeout=60, capture_output=True)
        assert result.returncode == 23
        with engine.begin() as c:
            doc = list_documents(c, owner, business)[0]
        assert doc.status == "failed" and doc.error_code == "interrupted_job"
        if stage == "inspect_pdf_file":
            assert document_file_path(owner, business, doc.id).exists()
            assert retry_document_processing(engine, owner, business, doc.id).status == "ready"
        else:
            assert not document_file_path(owner, business, doc.id).exists()
            assert retry_document_processing(engine, owner, business, doc.id).error_code == "missing_storage_file"
        delete_document(engine, owner, business, doc.id)

    def test_database_active_job_index(self, workspace):
        engine, _, owner, _, business, second = workspace
        values = dict(owner_id=owner, filename="job.pdf", sha256="a" * 64, byte_size=10, status="processing")
        with engine.begin() as c:
            c.execute(documents.insert().values(id=uuid4(), business_id=business, **values))
        with pytest.raises(IntegrityError), engine.begin() as c:
            c.execute(documents.insert().values(id=uuid4(), business_id=second, **values))

    def test_http_owner_isolation_and_file_removal(self, env):
        engine, storage_dir, request_model, created_owners = env
        valid_pdf = build_minimal_pdf(["Revenue 120000"])
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
        anon = TestClient(app)
        base = f"/api/businesses/{api_biz_a}/documents"
        assert anon.get(base).status_code == 401
        assert anon.get(f"{base}/{api_doc_id}/file").status_code == 401
        assert anon.post(f"{base}/{api_doc_id}/retry").status_code == 401
        assert anon.delete(f"{base}/{api_doc_id}").status_code == 401
        assert anon.post(base, files={"file": ("test.pdf", valid_pdf, "application/pdf")}).status_code == 401
        assert upload_res.json()["status"] == "ready"

        file_res = client.get(
            f"/api/businesses/{api_biz_a}/documents/{api_doc_id}/file"
        )
        assert file_res.status_code == 200
        assert file_res.content == valid_pdf
        assert file_res.headers["x-content-type-options"] == "nosniff"

        # Cross-owner access returns 404 on each protected document path.
        client_b = TestClient(app)
        reg_b = client_b.post(
            "/api/auth/register",
            json={"email": email_b, "password": "correct-horse-battery"},
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])
        assert client_b.post(f"/api/businesses/{api_biz_a}/documents", files={"file": ("test.pdf", valid_pdf, "application/pdf")}).status_code == 404

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
