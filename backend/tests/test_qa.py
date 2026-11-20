"""Tests for P4-03 evidence-grounded workspace Q&A, citation verification, guardrails, and fallback."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
from urllib.error import URLError
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest

from app.analysis import analyse
from app.auth import SESSION_COOKIE
from app.database import get_engine
from app.main import app
import app.main as main_module
from app.models import businesses, owners
from app.qa import (
    OllamaUnavailableError,
    QAContext,
    _read_ollama_config,
    answer_workspace_question,
    call_local_ollama,
)
from app.schemas import (
    AnalysisRequest,
    QARequest,
    RetrievedPassage,
    SessionResponse,
    WorkspaceResponse,
)


def _aster_request() -> AnalysisRequest:
    data = json.loads(
        (Path(__file__).parent / "fixtures" / "aster_components.json").read_text()
    )["request"]
    for period in data["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = True
    return AnalysisRequest.model_validate(data)


def _sample_context(
    *,
    drop_fy24_interest: bool = False,
    with_passage: bool = True,
    retrieval_status: str = "ok",
    retrieval_note: str | None = None,
) -> QAContext:
    req = _aster_request()
    if drop_fy24_interest:
        for period in req.periods:
            if period.year_start == 2024:
                period.values.pop("interest_expense", None)
    analysis = analyse(req)
    biz_id = uuid4()
    doc_id = uuid4()
    workspace = WorkspaceResponse(
        business_id=biz_id,
        input_revision=2,
        request=req,
        latest_run_id=uuid4(),
        latest_analysis=analysis,
        runs=[],
        documents=[],
    )
    passages = (
        [
            RetrievedPassage(
                chunk_id=uuid4(),
                document_id=doc_id,
                filename="aster-reference.pdf",
                chunk_index=2,
                page_number=3,
                section="Note 4: Borrowings",
                period_years=[2023, 2024],
                content=(
                    "aster-reference.pdf | Page 3 | Note 4: Borrowings | FY 2023-24, FY 2024-25\n"
                    "Interest-bearing borrowings exclude lease liabilities and count current maturities once."
                ),
                token_count=34,
                score=0.78,
            )
        ]
        if with_passage
        else []
    )
    return QAContext(
        workspace=workspace,
        analysis=analysis,
        passages=passages,
        retrieval_status=retrieval_status,
        retrieval_note=retrieval_note,
    )


def test_qa_request_schema_enforces_bounds():
    valid = QARequest(question="  What is the net profit margin?  ", top_k=4, year_start=2024)
    assert valid.question == "What is the net profit margin?"
    assert valid.top_k == 4

    for bad in (
        {"question": "   "},
        {"question": "x" * 501},
        {"question": "ok", "top_k": 0},
        {"question": "ok", "top_k": 7},
        {"question": "ok", "document_id": "not-a-uuid"},
        {"question": "ok", "extra": True},
    ):
        with pytest.raises(Exception):
            QARequest.model_validate(bad)


def test_ollama_config_enforces_loopback_and_local_models(monkeypatch):
    monkeypatch.delenv("OLLAMA_DISABLED", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:4b")
    cfg = _read_ollama_config()
    assert cfg.base_url == "http://127.0.0.1:11434"
    assert cfg.model == "qwen3:4b"
    assert cfg.num_ctx == 4096
    assert cfg.num_predict == 1024

    for bad_url in ("https://127.0.0.1:11434", "http://10.0.0.5:11434", "https://api.example.com"):
        monkeypatch.setenv("OLLAMA_BASE_URL", bad_url)
        with pytest.raises(OllamaUnavailableError, match="loopback"):
            _read_ollama_config()

    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    for bad_model in ("qwen3:4b-cloud", "qwen3:cloud", "ollama.com/qwen3:4b"):
        monkeypatch.setenv("OLLAMA_MODEL", bad_model)
        with pytest.raises(OllamaUnavailableError, match="Cloud"):
            _read_ollama_config()

    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:4b")
    monkeypatch.setenv("OLLAMA_DISABLED", "1")
    with pytest.raises(OllamaUnavailableError, match="disabled"):
        _read_ollama_config()


def test_call_local_ollama_sends_d04_options_and_strips_thinking(monkeypatch):
    monkeypatch.delenv("OLLAMA_DISABLED", raising=False)
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_MODEL", "qwen3:4b")

    captured: dict = {}

    class _FakeResp:
        status = 200

        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return json.dumps(
                {
                    "message": {
                        "role": "assistant",
                        "thinking": "PRIVATE CHAIN OF THOUGHT THAT MUST NEVER BE SHOWN",
                        "content": "Net profit margin was 9.00% in FY 2023-24 [F2] and 5.00% in FY 2024-25 [F9].",
                    }
                }
            ).encode("utf-8")

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["timeout"] = timeout
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp()

    monkeypatch.setattr("app.qa.urlopen", fake_urlopen)
    model, content = call_local_ollama("sys", "usr")
    assert model == "qwen3:4b"
    assert "PRIVATE CHAIN OF THOUGHT" not in content
    assert "9.00%" in content
    assert captured["url"] == "http://127.0.0.1:11434/api/chat"
    assert captured["payload"]["think"] is True
    assert captured["payload"]["stream"] is False
    assert captured["payload"]["options"] == {
        "num_ctx": 4096,
        "temperature": 0,
        "seed": 42,
        "num_predict": 1024,
    }


def test_ollama_mode_verifies_citations_and_strips_hallucinated_ids():
    ctx = _sample_context()
    seen_prompt: dict[str, str] = {}

    def fake_llm(system_prompt: str, user_prompt: str) -> tuple[str, str]:
        seen_prompt["system"] = system_prompt
        seen_prompt["user"] = user_prompt
        return (
            "qwen3:4b",
            "Net profit margin changed from 9.00% [F2] to 5.00% [F9]. "
            "Borrowings exclude leases [D1]. Hallucinated ref [D99] [F999] must vanish.",
        )

    resp = answer_workspace_question(
        ctx, "Explain the net profit margin and borrowings note", llm_caller=fake_llm
    )
    assert resp.mode == "ollama"
    assert resp.model == "qwen3:4b"
    assert resp.fallback_reason is None
    assert "[D99]" not in resp.answer
    assert "[F999]" not in resp.answer
    assert "[F2]" in resp.answer and "[F9]" in resp.answer and "[D1]" in resp.answer
    assert '<untrusted_document_passage id="D1"' in seen_prompt["user"]
    cited_fin = {c.citation_id for c in resp.financial_citations if c.cited}
    cited_doc = {c.citation_id for c in resp.document_citations if c.cited}
    assert cited_fin == {"F2", "F9"}
    assert cited_doc == {"D1"}


def test_injected_or_forbidden_llm_verdict_reverts_to_deterministic_refusal():
    ctx = _sample_context()

    def compromised_llm(_system: str, _user: str) -> tuple[str, str]:
        return ("qwen3:4b", "Your credit score is 820 and your loan will be approved immediately.")

    resp = answer_workspace_question(
        ctx, "Will my loan be approved and what is my credit score?", llm_caller=compromised_llm
    )
    assert resp.mode == "fallback"
    assert "guardrails" in (resp.fallback_reason or "").lower()
    assert "820" not in resp.answer
    assert "cannot predict loan approval" in resp.answer.lower()
    assert any(c.cited for c in resp.financial_citations)


def test_fallback_handles_numerical_causal_missing_interest_and_document_questions(monkeypatch):
    def unreachable(_req, timeout):
        raise URLError("Connection refused")

    monkeypatch.delenv("OLLAMA_DISABLED", raising=False)
    monkeypatch.setattr("app.qa.urlopen", unreachable)

    # 1. Causal margin question -> reports exact Python values + refuses unsupported cause + cites passage.
    ctx = _sample_context()
    r_margin = answer_workspace_question(ctx, "Why did net profit margin drop?")
    assert r_margin.mode == "fallback"
    assert r_margin.model is None
    assert "not reachable" in (r_margin.fallback_reason or "").lower()
    assert "9.00%" in r_margin.answer
    assert "5.00%" in r_margin.answer
    assert "do not establish root causes" in r_margin.answer.lower()
    assert any(c.indicator == "net_profit_margin" and c.cited for c in r_margin.financial_citations)
    assert any(c.citation_id == "D1" and c.cited for c in r_margin.document_citations)

    # 2. Missing interest expense -> Not assessed + helpful request + unrelated indicators unaffected.
    ctx_missing = _sample_context(drop_fy24_interest=True)
    r_interest = answer_workspace_question(ctx_missing, "What is our interest coverage?")
    assert r_interest.mode == "fallback"
    assert "Not assessed" in r_interest.answer
    assert "interest expense" in r_interest.answer.lower()
    assert "5.00x" in r_interest.answer  # FY 2023-24 remains Supported
    assert any(
        c.indicator == "interest_coverage" and c.year_start == 2024 and c.state == "Not assessed" and c.cited
        for c in r_interest.financial_citations
    )
    assert any(
        c.indicator == "net_profit_margin" and c.year_start == 2024 and c.state == "Supported"
        for c in r_interest.financial_citations
    )

    # 3. Document question -> cites page/section and excerpt.
    r_doc = answer_workspace_question(ctx, "What do the borrowing notes say about leases?")
    assert "aster-reference.pdf, p. 3 (Note 4: Borrowings)" in r_doc.answer
    assert any(c.citation_id == "D1" and c.page_number == 3 and c.cited for c in r_doc.document_citations)

    # 4. Absent year filter -> explicitly warns rather than misattributing.
    r_year = answer_workspace_question(ctx, "Summarize revenue growth", year_start=2019)
    assert "FY 2019-20 is not entered" in r_year.answer


def test_qa_route_enforces_auth_ownership_and_graceful_fallback(monkeypatch):
    owner_a = uuid4()
    biz_a = uuid4()
    other_biz = uuid4()
    unknown_doc = uuid4()
    ctx = _sample_context(
        with_passage=False,
        retrieval_status="unavailable",
        retrieval_note="Local document passage search is unavailable (all-MiniLM-L6-v2 cache not loaded); numerical findings and evidence gaps remain available from saved figures.",
    )

    @contextmanager
    def fake_tx():
        yield object()

    def fake_require_session(_conn, request):
        token = request.cookies.get(SESSION_COOKIE)
        if token != "valid-session":
            from fastapi import HTTPException

            raise HTTPException(status_code=401, detail="Authentication required")
        return SessionResponse(owner_id=owner_a, email="owner@example.com")

    def fake_load_qa_context(_conn, owner_id, business_id, question, **kwargs):
        if owner_id != owner_a or business_id != biz_a:
            raise LookupError("Business not found")
        if kwargs.get("document_id") == unknown_doc:
            raise LookupError("Document not found")
        return ctx

    monkeypatch.setattr(main_module, "db_transaction", fake_tx)
    monkeypatch.setattr(main_module, "require_session", fake_require_session)
    monkeypatch.setattr(main_module, "load_qa_context", fake_load_qa_context)
    monkeypatch.setenv("OLLAMA_DISABLED", "1")

    client = TestClient(app)

    # Unauthenticated -> 401
    assert client.post(f"/api/businesses/{biz_a}/qa", json={"question": "What is working capital?"}).status_code == 401

    # Authenticated
    client.cookies.set(SESSION_COOKIE, "valid-session")

    # Cross-owner / unknown business -> uniform 404
    r_other = client.post(f"/api/businesses/{other_biz}/qa", json={"question": "What is working capital?"})
    r_unknown = client.post(f"/api/businesses/{uuid4()}/qa", json={"question": "What is working capital?"})
    assert r_other.status_code == 404 and r_unknown.status_code == 404
    assert r_other.json() == r_unknown.json()

    # Cross-owner / unknown document_id -> 404
    r_bad_doc = client.post(
        f"/api/businesses/{biz_a}/qa",
        json={"question": "What is in the note?", "document_id": str(unknown_doc)},
    )
    assert r_bad_doc.status_code == 404

    # Authorised request -> 200 with deterministic fallback and retrieval_status='unavailable'
    res = client.post(
        f"/api/businesses/{biz_a}/qa",
        json={"question": "What is working capital?"},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["mode"] == "fallback"
    assert body["retrieval_status"] == "unavailable"
    assert body["input_revision"] == 2
    assert body["rule_version"] == "financial-rules-v1"
    assert "INR 2000000.00" in body["answer"]
    assert "INR 2500000.00" in body["answer"]


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database with pgvector",
)
def test_live_qa_end_to_end_ownership_and_citations(monkeypatch):
    """Verify POST /api/businesses/{id}/qa end-to-end against PostgreSQL with fallback mode."""
    import shutil

    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    monkeypatch.setenv("OLLAMA_DISABLED", "1")
    storage_dir = (
        Path(__file__).resolve().parents[1] / ".storage" / f"test_qa_{uuid4().hex[:8]}"
    )
    monkeypatch.setenv("DOCUMENT_STORAGE_DIR", str(storage_dir))
    get_engine.cache_clear()
    engine = get_engine()
    created_owners: list = []

    try:
        alice = TestClient(app)
        bob = TestClient(app)
        anon = TestClient(app)

        reg_a = alice.post(
            "/api/auth/register",
            json={"email": f"p403-a-{uuid4().hex[:8]}@example.com", "password": "alice-password-123"},
        )
        assert reg_a.status_code == 201
        created_owners.append(reg_a.json()["owner_id"])

        reg_b = bob.post(
            "/api/auth/register",
            json={"email": f"p403-b-{uuid4().hex[:8]}@example.com", "password": "bob-password-12345"},
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        payload = _aster_request().model_dump(mode="json")
        biz_a = alice.post("/api/businesses", json=payload).json()["business_id"]

        # Unauthenticated and cross-owner isolation
        assert anon.post(f"/api/businesses/{biz_a}/qa", json={"question": "Net profit margin?"}).status_code == 401
        r_bob = bob.post(f"/api/businesses/{biz_a}/qa", json={"question": "Net profit margin?"})
        r_unk = bob.post(f"/api/businesses/{uuid4()}/qa", json={"question": "Net profit margin?"})
        assert r_bob.status_code == 404 and r_unk.status_code == 404
        assert r_bob.json() == r_unk.json()

        # Authorised Q&A without PDFs still answers from exact Python calculations
        res = alice.post(f"/api/businesses/{biz_a}/qa", json={"question": "What is our net profit margin?"})
        assert res.status_code == 200
        body = res.json()
        assert body["mode"] == "fallback"
        assert body["retrieval_status"] == "no_documents"
        assert "9.00%" in body["answer"] and "5.00%" in body["answer"]
    finally:
        shutil.rmtree(storage_dir, ignore_errors=True)
        with engine.begin() as connection:
            for owner_id in created_owners:
                connection.execute(businesses.delete().where(businesses.c.owner_id == owner_id))
                connection.execute(owners.delete().where(owners.c.id == owner_id))
        engine.dispose()
        get_engine.cache_clear()
