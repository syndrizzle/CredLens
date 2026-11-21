"""Tests for P5-01 versioned printable preparation reports, supersession, and access control."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import pytest

from app.analysis import analyse
from app.auth import SESSION_COOKIE
from app.database import get_engine
from app.main import app
import app.main as main_module
from app.models import businesses, owners
from app.reports import (
    REPORT_LIMITATION,
    _superseded_info,
    assemble_preparation_report,
    build_documents_referenced,
    build_missing_evidence,
)
from app.schemas import AnalysisRequest, ReportSummary, SessionResponse


def _aster_data(*, reviewed: bool = True) -> dict:
    data = json.loads(
        (Path(__file__).parent / "fixtures" / "aster_components.json").read_text()
    )["request"]
    for period in data["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = reviewed
    return data


def test_report_assembly_complete_missing_evidence_documents_and_limitations():
    doc_id = uuid4()
    data = _aster_data()
    data["periods"][1]["values"]["revenue"] = {
        "raw": "12000000.00",
        "reviewed": True,
        "revision": 1,
        "origin": "document",
        "source": {
            "document_id": str(doc_id),
            "filename": "aster-reference.pdf",
            "page_number": 1,
            "table_index": 1,
            "row_index": 2,
            "column_index": 2,
            "label": "Revenue from operations",
            "raw_token": "1,20,00,000.00",
        },
    }
    data["periods"][1]["values"]["ebit"] = {
        "raw": "1200000.00",
        "reviewed": True,
        "revision": 1,
        "origin": "document",
        "source": {
            "document_id": None,
            "filename": "removed-notes.pdf",
            "page_number": 2,
            "table_index": 1,
            "row_index": 4,
            "column_index": 2,
            "label": "EBIT",
            "raw_token": "12,00,000.00",
        },
    }

    req = AnalysisRequest.model_validate(data)
    analysis = analyse(req)
    report = assemble_preparation_report(
        report_id=uuid4(),
        business_id=uuid4(),
        report_version=1,
        input_revision=1,
        current_input_revision=1,
        superseded=False,
        superseded_reason=None,
        created_at=datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc),
        inputs=req,
        analysis=analysis,
    )
    assert report.report_schema_version == "preparation-report-v1"
    assert report.rule_version == "financial-rules-v1"
    assert report.action_version == "preparation-actions-v1"
    assert report.superseded is False
    # Base two-year Aster case has no prior year for FY 2023-24 revenue growth.
    assert len(report.missing_evidence) == 1
    assert report.missing_evidence[0].year_start == 2023
    assert report.missing_evidence[0].code == "missing_prior_year"
    assert report.missing_evidence[0].affected_analyses == ["revenue_growth"]
    assert REPORT_LIMITATION in report.limitations
    assert len(report.documents_referenced) == 2
    assert report.documents_referenced[0].filename == "aster-reference.pdf"
    assert report.documents_referenced[0].pages == [1]
    assert report.documents_referenced[0].detached is False
    assert report.documents_referenced[1].filename == "removed-notes.pdf"
    assert report.documents_referenced[1].detached is True

    # Missing interest + unreviewed current assets + balance conflict -> grouped & ordered
    gap_data = _aster_data()
    gap_data["periods"][1]["values"].pop("interest_expense")
    gap_data["periods"][1]["values"]["current_assets"]["reviewed"] = False
    gap_data["periods"][1]["values"]["total_assets"]["raw"] = "19000000.00"
    gap_analysis = analyse(AnalysisRequest.model_validate(gap_data))
    gaps = build_missing_evidence(gap_analysis)
    assert len(gaps) >= 3
    # Needs review items come before Not assessed items
    states = [item.state for item in gaps]
    assert states.index("Needs review") < states.index("Not assessed")
    # Missing interest blocks ONLY interest_coverage
    missing_int = [item for item in gaps if item.code == "missing_input"]
    assert len(missing_int) == 1
    assert missing_int[0].fields == ["interest_expense"]
    assert missing_int[0].affected_analyses == ["interest_coverage"]
    # Unreviewed current_assets groups working_capital and current_ratio together
    unrev_ca = [
        item
        for item in gaps
        if item.code == "unreviewed" and item.fields == ["current_assets"]
    ]
    assert len(unrev_ca) == 1
    assert set(unrev_ca[0].affected_analyses) == {"working_capital", "current_ratio"}

    # Document reference deduplication across multiple pages
    doc_refs = build_documents_referenced(req)
    assert len(doc_refs) == 2


def test_superseded_status_and_reasons_across_revisions_and_runs():
    r1, r2, r3 = uuid4(), uuid4(), uuid4()
    versions = {r1: 1, r2: 2, r3: 3}

    # Current report
    assert _superseded_info(r1, 1, 1, r1, 1, versions) == (False, None)

    # Workspace edited to Rev 2 before a new run is generated
    sup, reason = _superseded_info(r1, 1, 2, r1, 1, versions)
    assert sup is True
    assert "input revision 2" in (reason or "").lower()

    # Refreshed report v2 generated at Rev 2 -> v1 points to v2, v2 is current
    sup_v1, reason_v1 = _superseded_info(r1, 1, 2, r2, 2, versions)
    assert sup_v1 is True and "report v2" in (reason_v1 or "").lower()
    assert _superseded_info(r2, 2, 2, r2, 2, versions) == (False, None)

    # Newer report v3 on same revision supersedes v2
    sup_v2, reason_v2 = _superseded_info(r2, 2, 2, r3, 2, versions)
    assert sup_v2 is True and "report v3" in (reason_v2 or "").lower()


def test_report_routes_auth_ownership_and_negative_access_matrix_offline(monkeypatch):
    owner_a, owner_b = uuid4(), uuid4()
    biz_a1, biz_a2, biz_b1 = uuid4(), uuid4(), uuid4()
    rep_a1, rep_a2, rep_b1 = uuid4(), uuid4(), uuid4()

    req = AnalysisRequest.model_validate(_aster_data())
    analysis = analyse(req)
    now = datetime(2026, 11, 21, 12, 0, tzinfo=timezone.utc)
    sample_report = assemble_preparation_report(
        report_id=rep_a1,
        business_id=biz_a1,
        report_version=1,
        input_revision=1,
        current_input_revision=1,
        superseded=False,
        superseded_reason=None,
        created_at=now,
        inputs=req,
        analysis=analysis,
    )
    sample_summary = ReportSummary(
        report_id=rep_a1,
        business_id=biz_a1,
        report_version=1,
        input_revision=1,
        current_input_revision=1,
        rule_version=analysis.rule_version,
        action_version=analysis.action_version,
        superseded=False,
        superseded_reason=None,
        created_at=now,
    )

    tokens = {
        "tok-a": SessionResponse(owner_id=owner_a, email="a@example.com"),
        "tok-b": SessionResponse(owner_id=owner_b, email="b@example.com"),
    }
    owned_biz = {biz_a1: owner_a, biz_a2: owner_a, biz_b1: owner_b}
    owned_rep = {rep_a1: (owner_a, biz_a1), rep_a2: (owner_a, biz_a2), rep_b1: (owner_b, biz_b1)}

    @contextmanager
    def fake_tx():
        yield object()

    def fake_require_session(_conn, request):
        tok = request.cookies.get(SESSION_COOKIE)
        if tok not in tokens:
            raise HTTPException(status_code=401, detail="Authentication required")
        return tokens[tok]

    def fake_list(_conn, owner_id, business_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        return [sample_summary]

    def fake_generate(_conn, owner_id, business_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        return sample_report

    def fake_load(_conn, owner_id, business_id, report_id):
        if owned_biz.get(business_id) != owner_id:
            raise LookupError("Business not found")
        if owned_rep.get(report_id) != (owner_id, business_id):
            raise LookupError("Report not found")
        return sample_report

    monkeypatch.setattr(main_module, "db_transaction", fake_tx)
    monkeypatch.setattr(main_module, "require_session", fake_require_session)
    monkeypatch.setattr(main_module, "list_reports", fake_list)
    monkeypatch.setattr(main_module, "generate_report", fake_generate)
    monkeypatch.setattr(main_module, "load_report", fake_load)

    anon = TestClient(app)
    forged = TestClient(app)
    forged.cookies.set(SESSION_COOKIE, "forged-report-token")
    alice = TestClient(app)
    alice.cookies.set(SESSION_COOKIE, "tok-a")
    bob = TestClient(app)
    bob.cookies.set(SESSION_COOKIE, "tok-b")

    # 1. Unauthenticated & forged -> 401 across all 3 routes
    for client in (anon, forged):
        assert client.get(f"/api/businesses/{biz_a1}/reports").status_code == 401
        assert client.post(f"/api/businesses/{biz_a1}/reports").status_code == 401
        assert client.get(f"/api/businesses/{biz_a1}/reports/{rep_a1}").status_code == 401

    # 2. Cross-owner business -> uniform 404 identical to unknown business
    for method, path_a, path_u in (
        ("get", f"/api/businesses/{biz_a1}/reports", f"/api/businesses/{uuid4()}/reports"),
        ("post", f"/api/businesses/{biz_a1}/reports", f"/api/businesses/{uuid4()}/reports"),
        ("get", f"/api/businesses/{biz_a1}/reports/{rep_a1}", f"/api/businesses/{uuid4()}/reports/{rep_a1}"),
    ):
        r_cross = getattr(bob, method)(path_a)
        r_unk = getattr(bob, method)(path_u)
        assert r_cross.status_code == 404 and r_unk.status_code == 404
        assert r_cross.json() == r_unk.json()

    # 3. Cross-owner & cross-business report_id -> uniform 404 identical to unknown report_id
    r_cross_owner = alice.get(f"/api/businesses/{biz_a1}/reports/{rep_b1}")
    r_cross_biz = alice.get(f"/api/businesses/{biz_a1}/reports/{rep_a2}")
    r_unk_rep = alice.get(f"/api/businesses/{biz_a1}/reports/{uuid4()}")
    assert r_cross_owner.status_code == r_cross_biz.status_code == r_unk_rep.status_code == 404
    assert r_cross_owner.json() == r_cross_biz.json() == r_unk_rep.json()

    # 4. Authorised happy path
    assert alice.get(f"/api/businesses/{biz_a1}/reports").status_code == 200
    created = alice.post(f"/api/businesses/{biz_a1}/reports")
    assert created.status_code == 200
    assert created.json()["report_schema_version"] == "preparation-report-v1"
    loaded = alice.get(f"/api/businesses/{biz_a1}/reports/{rep_a1}")
    assert loaded.status_code == 200
    assert loaded.json()["report_id"] == str(rep_a1)


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database",
)
def test_live_reports_versioning_supersession_and_isolation(monkeypatch):
    """End-to-end live PostgreSQL verification of report generation, supersession, and ownership."""
    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    get_engine.cache_clear()
    engine = get_engine()
    created_owners: list = []

    try:
        alice = TestClient(app)
        bob = TestClient(app)

        reg_a = alice.post(
            "/api/auth/register",
            json={"email": f"p501-a-{uuid4().hex[:8]}@example.com", "password": "alice-password-123"},
        )
        assert reg_a.status_code == 201
        created_owners.append(reg_a.json()["owner_id"])

        reg_b = bob.post(
            "/api/auth/register",
            json={"email": f"p501-b-{uuid4().hex[:8]}@example.com", "password": "bob-password-12345"},
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        base = _aster_data()
        biz_a = alice.post("/api/businesses", json=base).json()["business_id"]

        # Generate v1 (and verify idempotency on unchanged revision)
        v1 = alice.post(f"/api/businesses/{biz_a}/reports").json()
        v1_again = alice.post(f"/api/businesses/{biz_a}/reports").json()
        assert v1["report_id"] == v1_again["report_id"]
        assert v1["report_version"] == 1 and v1["superseded"] is False

        # Edit interest -> Rev 2 immediately supersedes v1
        rev2 = deepcopy(base)
        rev2["periods"][1]["values"]["interest_expense"]["raw"] = "300000.00"
        assert alice.put(f"/api/businesses/{biz_a}", json={**rev2, "expected_revision": 1}).status_code == 200

        v1_after_edit = alice.get(f"/api/businesses/{biz_a}/reports/{v1['report_id']}").json()
        assert v1_after_edit["superseded"] is True
        assert v1_after_edit["current_input_revision"] == 2

        # Generate v2 -> Current at Rev 2 (4.00x), while v1 stays readable as Superseded
        v2 = alice.post(f"/api/businesses/{biz_a}/reports").json()
        assert v2["report_version"] == 2
        assert v2["input_revision"] == 2
        assert v2["superseded"] is False

        listing = alice.get(f"/api/businesses/{biz_a}/reports").json()
        assert len(listing) == 2
        assert listing[0]["report_id"] == v2["report_id"] and listing[0]["superseded"] is False
        assert listing[1]["report_id"] == v1["report_id"] and listing[1]["superseded"] is True

        # Cross-owner isolation
        assert bob.get(f"/api/businesses/{biz_a}/reports").status_code == 404
        assert bob.post(f"/api/businesses/{biz_a}/reports").status_code == 404
        assert bob.get(f"/api/businesses/{biz_a}/reports/{v2['report_id']}").status_code == 404
    finally:
        with engine.begin() as connection:
            for owner_id in created_owners:
                connection.execute(businesses.delete().where(businesses.c.owner_id == owner_id))
                connection.execute(owners.delete().where(owners.c.id == owner_id))
        engine.dispose()
        get_engine.cache_clear()
