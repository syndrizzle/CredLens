"""Tests for P5-02 active-data workspace deletion, minimal audit events, and final ownership matrix."""

from contextlib import contextmanager
from datetime import datetime, timezone
import io
import json
import os
from pathlib import Path
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest
from sqlalchemy import func, select

from app.audit import (
    record_audit_event,
    sanitize_audit_details,
)
from app.auth import SESSION_COOKIE
from app.database import get_engine
from app.documents import (
    WORKSPACE_BACKUP_NOTICE,
    WORKSPACE_CHAT_NOTE,
    DocumentRejectError,
    document_file_path,
)
from app.main import app
import app.main as main_module
from app.models import (
    analysis_runs,
    audit_events,
    businesses,
    document_chunks,
    documents,
    figures,
    metadata,
    owners,
    periods,
    revisions,
)
from app.schemas.audit import AuditEventSummary
from app.schemas.auth import SessionResponse
from app.schemas.workspaces import WorkspaceDeleteResponse


def _aster_data() -> dict:
    data = json.loads(
        (Path(__file__).parent / "fixtures" / "aster_components.json").read_text()
    )["request"]
    for period in data["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = True
    return data


def test_audit_details_sanitizer_rejects_financial_and_sensitive_payloads():
    clean = sanitize_audit_details(
        {
            "input_revision": 2,
            "report_version": 1,
            "status": "ready",
            "documents_removed": 3,
        }
    )
    assert clean == {
        "input_revision": 2,
        "report_version": 1,
        "status": "ready",
        "documents_removed": 3,
    }
    assert sanitize_audit_details(None) is None
    assert sanitize_audit_details({}) is None

    # Every financial, document, credential, or Q&A payload key must be rejected.
    for forbidden_key in (
        "revenue",
        "raw",
        "normalized_inr",
        "profit_after_tax",
        "password",
        "email",
        "business_name",
        "filename",
        "content",
        "question",
        "answer",
        "inputs",
        "results",
    ):
        with pytest.raises(ValueError, match="not allowed"):
            sanitize_audit_details({forbidden_key: "12000000.00"})

    with pytest.raises(ValueError, match="64 characters"):
        sanitize_audit_details({"status": "x" * 65})

    with pytest.raises(ValueError, match="safe scalar"):
        sanitize_audit_details({"status": {"nested": True}})

    with pytest.raises(ValueError, match="Unsupported audit action"):
        record_audit_event(object(), uuid4(), "drop_table")  # type: ignore[arg-type]



def test_audit_migration_chain_and_offline_ddl():
    backend_dir = Path(__file__).resolve().parents[1]
    cfg = Config(str(backend_dir / "alembic.ini"))
    cfg.set_main_option("script_location", str(backend_dir / "migrations"))
    script = ScriptDirectory.from_config(cfg)

    heads = script.get_heads()
    assert heads == ["b8e4f1a9c305"]
    head_rev = script.get_revision("b8e4f1a9c305")
    assert head_rev is not None
    assert head_rev.down_revision == "a7c3d9e2f104"

    assert "audit_events" in metadata.tables
    table = metadata.tables["audit_events"]
    assert set(table.columns.keys()) == {
        "id",
        "owner_id",
        "action",
        "resource_type",
        "resource_id",
        "business_id",
        "details",
        "created_at",
    }

    # Verify Alembic generates clean PostgreSQL DDL offline for both upgrade and downgrade.
    up_buf = io.StringIO()
    cfg.output_buffer = up_buf
    command.upgrade(cfg, "a7c3d9e2f104:b8e4f1a9c305", sql=True)
    up_sql = up_buf.getvalue()
    assert "CREATE TABLE audit_events" in up_sql
    assert "ix_audit_events_owner_created" in up_sql

    down_buf = io.StringIO()
    cfg.output_buffer = down_buf
    command.downgrade(cfg, "b8e4f1a9c305:a7c3d9e2f104", sql=True)
    down_sql = down_buf.getvalue()
    assert "DROP TABLE audit_events" in down_sql


def test_phase5_final_negative_access_matrix_offline(monkeypatch):
    """Consolidated 28-case negative access matrix spanning workspaces, reports, deletion, and audit."""
    owner_a, owner_b = uuid4(), uuid4()
    biz_a1, biz_a2, biz_b1 = uuid4(), uuid4(), uuid4()
    doc_a1, doc_b1 = uuid4(), uuid4()
    rep_a1, rep_b1 = uuid4(), uuid4()
    now = datetime(2026, 11, 21, 15, 0, tzinfo=timezone.utc)

    tokens = {
        "tok-a": SessionResponse(owner_id=owner_a, email="a@example.com"),
        "tok-b": SessionResponse(owner_id=owner_b, email="b@example.com"),
    }
    owned_biz = {biz_a1: owner_a, biz_a2: owner_a, biz_b1: owner_b}
    owned_rep = {rep_a1: (owner_a, biz_a1), rep_b1: (owner_b, biz_b1)}
    owned_doc = {doc_a1: (owner_a, biz_a1), doc_b1: (owner_b, biz_b1)}
    events_by_owner = {
        owner_a: [
            AuditEventSummary(
                id=uuid4(),
                owner_id=owner_a,
                action="workspace_created",
                resource_type="workspace",
                resource_id=biz_a1,
                business_id=biz_a1,
                details={"input_revision": 1},
                created_at=now,
            )
        ],
        owner_b: [],
    }
    delete_error: list[Exception | None] = [None]

    @contextmanager
    def fake_tx():
        yield object()

    def fake_require_session(_conn, request):
        tok = request.cookies.get(SESSION_COOKIE)
        if tok not in tokens:
            raise HTTPException(status_code=401, detail="Authentication required")
        return tokens[tok]

    def fake_load_ws(_conn, owner_id, business_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        raise AssertionError("Should not reach workspace body")

    def fake_delete_ws(_engine, owner_id, business_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        if delete_error[0] is not None:
            raise delete_error[0]
        return WorkspaceDeleteResponse(
            business_id=business_id,
            documents_removed=1,
            runs_removed=2,
            revisions_removed=2,
            chat_note=WORKSPACE_CHAT_NOTE,
            backup_notice=WORKSPACE_BACKUP_NOTICE,
        )

    def fake_load_rep(_conn, owner_id, business_id, report_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        if owned_rep.get(report_id) != (owner_id, business_id):
            raise LookupError("Report not found")
        raise AssertionError("Should not reach report body")

    def fake_list_rep(_conn, owner_id, business_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        return []

    def fake_doc_ext(_conn, owner_id, business_id, document_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        if owned_doc.get(document_id) != (owner_id, business_id):
            raise LookupError("Document not found")
        raise AssertionError("Should not reach extraction body")

    def fake_retrieve(_conn, owner_id, business_id, query, **kwargs):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        raise AssertionError("Should not reach retrieval body")

    def fake_qa(_conn, owner_id, business_id, question, **kwargs):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        raise AssertionError("Should not reach qa body")

    def fake_list_audit(_conn, owner_id, *, business_id=None, limit=50):
        items = events_by_owner.get(owner_id, [])
        if business_id is not None:
            items = [e for e in items if e.business_id == business_id]
        return items[:limit]

    monkeypatch.setattr(main_module, "db_transaction", fake_tx)
    monkeypatch.setattr(main_module, "get_engine", lambda: object())
    monkeypatch.setattr(main_module, "require_session", fake_require_session)
    monkeypatch.setattr(main_module, "load_workspace", fake_load_ws)
    monkeypatch.setattr(main_module, "delete_workspace", fake_delete_ws)
    monkeypatch.setattr(main_module, "load_report", fake_load_rep)
    monkeypatch.setattr(main_module, "list_reports", fake_list_rep)
    monkeypatch.setattr(main_module, "generate_report", fake_list_rep)
    monkeypatch.setattr(main_module, "get_document_extraction", fake_doc_ext)
    monkeypatch.setattr(main_module, "retrieve_passages", fake_retrieve)
    monkeypatch.setattr(main_module, "load_qa_context", fake_qa)
    monkeypatch.setattr(main_module, "list_audit_events", fake_list_audit)

    anon = TestClient(app)
    forged = TestClient(app)
    forged.cookies.set(SESSION_COOKIE, "forged-final-matrix-token")
    alice = TestClient(app)
    alice.cookies.set(SESSION_COOKIE, "tok-a")
    bob = TestClient(app)
    bob.cookies.set(SESSION_COOKIE, "tok-b")

    cases = 0

    # 1-14: Unauthenticated & forged session rejected with 401 across 7 core resource groups
    for client in (anon, forged):
        assert client.get(f"/api/businesses/{biz_a1}").status_code == 401
        assert client.delete(f"/api/businesses/{biz_a1}").status_code == 401
        assert client.get(f"/api/businesses/{biz_a1}/reports").status_code == 401
        assert client.post(f"/api/businesses/{biz_a1}/reports").status_code == 401
        assert client.get(f"/api/businesses/{biz_a1}/reports/{rep_a1}").status_code == 401
        assert client.post(f"/api/businesses/{biz_a1}/qa", json={"question": "margin"}).status_code == 401
        assert client.get("/api/audit-events").status_code == 401
        cases += 7

    # 15-22: Cross-owner business access returns uniform 404 identical to unknown business
    for method, p_owned, p_unknown, body in (
        ("get", f"/api/businesses/{biz_a1}", f"/api/businesses/{uuid4()}", None),
        ("delete", f"/api/businesses/{biz_a1}", f"/api/businesses/{uuid4()}", None),
        ("get", f"/api/businesses/{biz_a1}/reports", f"/api/businesses/{uuid4()}/reports", None),
        ("post", f"/api/businesses/{biz_a1}/reports", f"/api/businesses/{uuid4()}/reports", None),
        ("get", f"/api/businesses/{biz_a1}/reports/{rep_a1}", f"/api/businesses/{uuid4()}/reports/{rep_a1}", None),
        ("get", f"/api/businesses/{biz_a1}/documents/{doc_a1}/extraction", f"/api/businesses/{uuid4()}/documents/{doc_a1}/extraction", None),
        ("post", f"/api/businesses/{biz_a1}/retrieval", f"/api/businesses/{uuid4()}/retrieval", {"query": "revenue"}),
        ("post", f"/api/businesses/{biz_a1}/qa", f"/api/businesses/{uuid4()}/qa", {"question": "revenue"}),
    ):
        kw = {"json": body} if body is not None else {}
        r_cross = getattr(bob, method)(p_owned, **kw)
        r_unk = getattr(bob, method)(p_unknown, **kw)
        assert r_cross.status_code == 404 and r_unk.status_code == 404
        assert r_cross.json() == r_unk.json()
        cases += 1

    # 23-26: Cross-owner & cross-business child IDs return uniform 404 identical to unknown IDs
    r_rep_cross = alice.get(f"/api/businesses/{biz_a1}/reports/{rep_b1}")
    r_rep_unk = alice.get(f"/api/businesses/{biz_a1}/reports/{uuid4()}")
    assert r_rep_cross.status_code == r_rep_unk.status_code == 404
    assert r_rep_cross.json() == r_rep_unk.json()
    cases += 2

    r_doc_cross = alice.get(f"/api/businesses/{biz_a1}/documents/{doc_b1}/extraction")
    r_doc_unk = alice.get(f"/api/businesses/{biz_a1}/documents/{uuid4()}/extraction")
    assert r_doc_cross.status_code == r_doc_unk.status_code == 404
    assert r_doc_cross.json() == r_doc_unk.json()
    cases += 2

    # 27-28: Audit events never leak across owners even when querying another owner's business_id
    r_bob_audit = bob.get("/api/audit-events")
    r_bob_audit_filtered = bob.get(f"/api/audit-events?business_id={biz_a1}")
    assert r_bob_audit.status_code == 200 and r_bob_audit.json() == []
    assert r_bob_audit_filtered.status_code == 200 and r_bob_audit_filtered.json() == []
    cases += 2
    assert cases == 28

    # Authorised owner audit events + deletion happy path + 409 active job + 503 pending removal
    r_alice_audit = alice.get("/api/audit-events")
    assert r_alice_audit.status_code == 200 and len(r_alice_audit.json()) == 1
    assert r_alice_audit.json()[0]["action"] == "workspace_created"

    delete_error[0] = DocumentRejectError(409, "active_job_exists", "Another PDF job is active.")
    assert alice.delete(f"/api/businesses/{biz_a1}").status_code == 409

    delete_error[0] = DocumentRejectError(503, "deletion_pending", "Workspace removal is pending.")
    assert alice.delete(f"/api/businesses/{biz_a1}").status_code == 503

    delete_error[0] = None
    deleted = alice.delete(f"/api/businesses/{biz_a1}")
    assert deleted.status_code == 200
    body = deleted.json()
    assert body["status"] == "deleted"
    assert body["documents_removed"] == 1
    assert "not immediately purged" in body["backup_notice"]
    assert "request-scoped" in body["chat_note"]


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database",
)
def test_live_workspace_deletion_audit_and_backup_limits(monkeypatch):
    """End-to-end live verification of workspace deletion, cascade cleanup, and minimal audit log."""
    import shutil
    import app.documents as document_module

    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    monkeypatch.setenv("OLLAMA_DISABLED", "1")
    storage_dir = (
        Path(__file__).resolve().parents[1] / ".storage" / f"test_p502_{uuid4().hex[:8]}"
    )
    monkeypatch.setenv("DOCUMENT_STORAGE_DIR", str(storage_dir))
    get_engine.cache_clear()
    engine = get_engine()
    created_owners: list = []

    aster_pdf = (
        Path(__file__).resolve().parent / "fixtures" / "pdf_corpus" / "aster-reference.pdf"
    ).read_bytes()

    try:
        alice = TestClient(app)
        bob = TestClient(app)

        reg_a = alice.post(
            "/api/auth/register",
            json={"email": f"p502-a-{uuid4().hex[:8]}@example.com", "password": "alice-password-123"},
        )
        assert reg_a.status_code == 201
        owner_a = reg_a.json()["owner_id"]
        created_owners.append(owner_a)

        reg_b = bob.post(
            "/api/auth/register",
            json={"email": f"p502-b-{uuid4().hex[:8]}@example.com", "password": "bob-password-12345"},
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        ws = alice.post("/api/businesses", json=_aster_data()).json()
        biz_a = ws["business_id"]
        doc = alice.post(
            f"/api/businesses/{biz_a}/documents",
            files={"file": ("aster-reference.pdf", aster_pdf, "application/pdf")},
        ).json()
        doc_path = document_file_path(
            UUID(owner_a),
            UUID(biz_a),
            UUID(doc["id"]),
        )
        assert doc_path.is_file()

        documents_path = f"/api/businesses/{biz_a}/documents/{doc['id']}"
        extraction = alice.get(f"{documents_path}/extraction").json()["extraction"]
        revenue = next(c for c in extraction["candidates"] if c["field"] == "revenue" and c["year_start"] == 2024)
        inputs = _aster_data()
        inputs["periods"][1]["values"]["revenue"] = {
            "raw": revenue["amount"], "reviewed": True, "origin": "document",
            "source": {
                **{key: revenue[key] for key in ("page_number", "table_index", "row_index", "column_index", "label")},
                "document_id": doc["id"], "filename": doc["filename"], "raw_token": revenue["raw"],
            },
        }
        assert alice.put(f"/api/businesses/{biz_a}", json={**inputs, "expected_revision": 1}).status_code == 200
        report = alice.post(f"/api/businesses/{biz_a}/reports")
        assert report.status_code == 200 and report.json()["documents_referenced"][0]["detached"] is False
        assert alice.post(f"/api/businesses/{biz_a}/qa", json={"question": "Net profit margin?"}).status_code == 200

        # Bob cannot delete Alice's workspace or read Alice's audit events
        assert bob.delete(f"/api/businesses/{biz_a}").status_code == 404
        assert doc_path.is_file()
        assert bob.get(f"/api/audit-events?business_id={biz_a}").json() == []

        def failed_unlink(_path):
            raise OSError("simulated workspace unlink failure")

        with monkeypatch.context() as fault:
            fault.setattr(document_module, "_remove_file_and_empty_dirs", failed_unlink)
            failed = alice.delete(f"/api/businesses/{biz_a}")
        assert failed.status_code == 503 and failed.json()["detail"]["code"] == "deletion_pending"
        assert doc_path.is_file()
        assert alice.get(f"{documents_path}/file").status_code == 404
        historical = alice.get(f"/api/businesses/{biz_a}/reports/{report.json()['report_id']}").json()
        assert historical["documents_referenced"][0]["detached"] is True
        assert historical["inputs"] == report.json()["inputs"]
        assert not any(e["action"] == "workspace_deleted" for e in alice.get("/api/audit-events").json())

        # A retry removes the files and derived rows and records the completed deletion.
        del_resp = alice.delete(f"/api/businesses/{biz_a}")
        assert del_resp.status_code == 200
        del_body = del_resp.json()
        assert del_body["documents_removed"] == 1
        assert del_body["runs_removed"] >= 1
        assert del_body["revisions_removed"] >= 1
        assert not doc_path.exists()

        with engine.connect() as conn:
            for tbl, col in (
                (businesses, businesses.c.id),
                (periods, periods.c.business_id),
                (revisions, revisions.c.business_id),
                (analysis_runs, analysis_runs.c.business_id),
                (documents, documents.c.business_id),
                (document_chunks, document_chunks.c.business_id),
            ):
                assert (
                    conn.execute(select(func.count()).select_from(tbl).where(col == biz_a)).scalar_one()
                    == 0
                )
            assert (
                conn.execute(
                    select(func.count())
                    .select_from(figures)
                    .join(periods, figures.c.period_id == periods.c.id)
                    .where(periods.c.business_id == biz_a)
                ).scalar_one()
                == 0
            )

        # Deleted workspace is gone across all endpoints
        assert alice.get(f"/api/businesses/{biz_a}").status_code == 404
        assert alice.get(f"/api/businesses/{biz_a}/reports").status_code == 404
        assert alice.post(f"/api/businesses/{biz_a}/qa", json={"question": "margin"}).status_code == 404

        # Audit log retains lifecycle actions with zero financial payloads
        events = alice.get("/api/audit-events").json()
        actions = {e["action"] for e in events}
        assert {
            "account_registered",
            "workspace_created",
            "document_uploaded",
            "report_generated",
            "qa_asked",
            "workspace_deleted",
        }.issubset(actions)
        serialized = json.dumps(events)
        assert "12000000" not in serialized
        assert "Aster Components" not in serialized
        assert "aster-reference.pdf" not in serialized
    finally:
        shutil.rmtree(storage_dir, ignore_errors=True)
        with engine.begin() as connection:
            for owner_id in created_owners:
                connection.execute(businesses.delete().where(businesses.c.owner_id == owner_id))
                connection.execute(owners.delete().where(owners.c.id == owner_id))
        engine.dispose()
        get_engine.cache_clear()
