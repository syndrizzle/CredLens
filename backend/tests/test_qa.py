"""Tests for P4-03 evidence-grounded workspace Q&A, citation verification, guardrails, and fallback."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
from urllib.error import URLError
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from pydantic import ValidationError

from app.analysis import analyse
from app.auth import SESSION_COOKIE
from app.database import get_engine
from app.main import app
import app.main as main_module
from app.models import businesses, owners
from app.llm import ModelUnavailableError, _read_model_config, call_model
from app.qa import (
    QAContext,
    answer_workspace_question,
    ui_message_stream,
)
from app.schemas.auth import SessionResponse
from app.schemas.evidence import QARequest, RetrievedPassage
from app.schemas.financial import AnalysisRequest


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
        business_name=req.business_name,
        input_revision=2,
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
        with pytest.raises(ValidationError):
            QARequest.model_validate(bad)


def _configure_model(monkeypatch, url="https://credlens-ai.example.workers.dev/v1/answer"):
    monkeypatch.delenv("CREDLENS_AI_DISABLED", raising=False)
    monkeypatch.setenv("CREDLENS_AI_URL", url)
    monkeypatch.setenv("CREDLENS_AI_TOKEN", "test-token")


def test_model_config_requires_https_token_and_respects_disable(monkeypatch):
    _configure_model(monkeypatch)
    cfg = _read_model_config()
    assert cfg.url == "https://credlens-ai.example.workers.dev/v1/answer"
    assert cfg.token == "test-token"
    assert cfg.timeout_seconds == 30.0

    monkeypatch.setenv("CREDLENS_AI_URL", "http://127.0.0.1:8787/v1/answer")
    assert _read_model_config().url.startswith("http://127.0.0.1")

    for bad_url in ("http://api.example.com/v1/answer", "ftp://example.com", "https://"):
        monkeypatch.setenv("CREDLENS_AI_URL", bad_url)
        with pytest.raises(ModelUnavailableError, match="HTTPS"):
            _read_model_config()

    _configure_model(monkeypatch)
    monkeypatch.setenv("CREDLENS_AI_TOKEN", "")
    with pytest.raises(ModelUnavailableError, match="not configured"):
        _read_model_config()

    _configure_model(monkeypatch)
    monkeypatch.setenv("CREDLENS_AI_DISABLED", "1")
    with pytest.raises(ModelUnavailableError, match="disabled"):
        _read_model_config()


def test_call_model_sends_prompts_with_bearer_token_and_validates_reply(monkeypatch):
    _configure_model(monkeypatch)
    captured: dict = {}
    reply: dict = {"body": {"model": "@cf/google/gemma-4-26b-a4b-it", "content": " Net profit margin was 9.00% [F2]. "}}

    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self, _limit):
            return json.dumps(reply["body"]).encode("utf-8")

    def fake_urlopen(req, timeout):
        captured["url"] = req.full_url
        captured["auth"] = req.get_header("Authorization")
        captured["agent"] = req.get_header("User-agent")
        captured["timeout"] = timeout
        captured["payload"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp()

    monkeypatch.setattr("app.llm.urlopen", fake_urlopen)
    model, content = call_model("sys", "usr")
    assert model == "@cf/google/gemma-4-26b-a4b-it"
    assert content == "Net profit margin was 9.00% [F2]."
    assert captured == {
        "url": "https://credlens-ai.example.workers.dev/v1/answer",
        "auth": "Bearer test-token",
        "agent": "CredLens-backend",
        "timeout": 30.0,
        "payload": {"system": "sys", "user": "usr"},
    }

    for bad in ({"model": "m", "content": "  "}, {"error": "model_unavailable"}, ["not", "a", "dict"]):
        reply["body"] = bad
        with pytest.raises(ModelUnavailableError, match="empty answer"):
            call_model("sys", "usr")


def test_model_mode_verifies_citations_and_strips_hallucinated_ids():
    ctx = _sample_context()
    seen_prompt: dict[str, str] = {}

    def fake_llm(system_prompt: str, user_prompt: str) -> tuple[str, str]:
        seen_prompt["system"] = system_prompt
        seen_prompt["user"] = user_prompt
        return (
            "qwen3:4b",
            "Net profit margin changed from 9.00% [F2] to 5.00% [F9]. "
            "Borrowings exclude leases [D1]. Unavailable references [D99] [F999] [F1] must vanish.",
        )

    resp = answer_workspace_question(
        ctx, "Explain the net profit margin and borrowings note", llm_caller=fake_llm
    )
    assert resp.mode == "model"
    assert resp.model == "qwen3:4b"
    assert resp.fallback_reason is None
    assert "[D99]" not in resp.answer
    assert "[F999]" not in resp.answer
    assert "[F1]" not in resp.answer and "[F1]" not in seen_prompt["user"]
    assert any(c.citation_id == "F1" and not c.cited for c in resp.financial_citations)
    assert "[F2]" in resp.answer and "[F9]" in resp.answer and "[D1]" in resp.answer
    assert '<untrusted_document_passage id="D1"' in seen_prompt["user"]
    cited_fin = {c.citation_id for c in resp.financial_citations if c.cited}
    cited_doc = {c.citation_id for c in resp.document_citations if c.cited}
    assert cited_fin == {"F2", "F9"}
    assert cited_doc == {"D1"}


def test_grouped_model_citations_are_split_and_verified_individually():
    resp = answer_workspace_question(
        _sample_context(),
        "Explain the net profit margin and borrowings note",
        llm_caller=lambda _s, _u: ("@cf/google/gemma-4-26b-a4b-it", "Margin fell [F2, F9]; leases are excluded [D1; D99]."),
    )
    assert resp.mode == "model"
    assert resp.answer == "Margin fell [F2] [F9]; leases are excluded [D1]."
    assert {c.citation_id for c in resp.financial_citations if c.cited} == {"F2", "F9"}
    assert {c.citation_id for c in resp.document_citations if c.cited} == {"D1"}


def test_injected_or_forbidden_llm_verdict_reverts_to_deterministic_refusal():
    ctx = _sample_context()

    def compromised_llm(_system: str, _user: str) -> tuple[str, str]:
        return ("qwen3:4b", "Your credit score is 820 and your loan will be approved immediately.")

    resp = answer_workspace_question(
        ctx, "What do the borrowing notes say?", llm_caller=compromised_llm
    )
    assert resp.mode == "fallback"
    assert "guardrails" in (resp.fallback_reason or "").lower()
    assert "820" not in resp.answer
    assert any(c.cited for c in resp.financial_citations)


def test_fallback_handles_numerical_causal_missing_interest_and_document_questions(monkeypatch):
    def unreachable(_req, timeout):
        raise URLError("Connection refused")

    _configure_model(monkeypatch)
    monkeypatch.setattr("app.llm.urlopen", unreachable)

    # 1. Causal margin question -> reports exact Python values + refuses unsupported cause + cites passage.
    ctx = _sample_context()
    outage = answer_workspace_question(ctx, "What is our net profit margin?")
    assert outage.mode == "fallback" and "not reachable" in (outage.fallback_reason or "").lower()
    r_margin = answer_workspace_question(ctx, "Why did net profit margin drop?")
    assert r_margin.mode == "deterministic"
    assert r_margin.model is None
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
    assert not r_interest.document_citations
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
    assert answer_workspace_question(ctx, "Are leases excluded?").document_citations[0].cited

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
    monkeypatch.setenv("CREDLENS_AI_DISABLED", "1")

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

    # Streaming route: same checks before the stream starts, then the checked answer as UI message events.
    anon = TestClient(app)
    assert anon.post(f"/api/businesses/{biz_a}/qa/stream", json={"question": "What is working capital?"}).status_code == 401
    assert client.post(f"/api/businesses/{other_biz}/qa/stream", json={"question": "What is working capital?"}).status_code == 404
    assert client.post(f"/api/businesses/{biz_a}/qa/stream", json={"question": ""}).status_code == 422
    streamed = client.post(f"/api/businesses/{biz_a}/qa/stream", json={"question": "What is working capital?"})
    assert streamed.status_code == 200
    assert streamed.headers["content-type"].startswith("text/event-stream")
    assert streamed.headers["x-vercel-ai-ui-message-stream"] == "v1"
    frames = [line.removeprefix("data: ") for line in streamed.text.split("\n\n") if line]
    assert frames[-1] == "[DONE]"
    chunks = [json.loads(frame) for frame in frames[:-1]]
    assert chunks[0] == {"type": "start"} and chunks[-1] == {"type": "finish"}
    meta = next(c for c in chunks if c["type"] == "data-qa")["data"]
    assert "answer" not in meta and meta["mode"] == "fallback" and meta["financial_citations"]
    text = "".join(c["delta"] for c in chunks if c["type"] == "text-delta")
    assert text == body["answer"]


def test_ui_message_stream_sends_cited_documents_as_page_links():
    biz = uuid4()
    resp = answer_workspace_question(_sample_context(), "What do the borrowing notes say?", llm_caller=lambda _s, _u: (
        "@cf/google/gemma-4-26b-a4b-it", "Borrowings exclude leases [D1]."))
    chunks = [json.loads(frame.removeprefix("data: ")) for frame in ui_message_stream(resp, biz) if frame != "data: [DONE]\n\n"]
    sources = [c for c in chunks if c["type"] == "source-url"]
    doc = next(c for c in resp.document_citations if c.citation_id == "D1")
    assert sources == [{
        "type": "source-url",
        "sourceId": "D1",
        "url": f"/api/businesses/{biz}/documents/{doc.document_id}/file#page={doc.page_number}",
        "title": f"{doc.filename}, p. {doc.page_number}",
    }]
    assert "".join(c["delta"] for c in chunks if c["type"] == "text-delta") == resp.answer


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database with pgvector",
)
def test_live_qa_end_to_end_ownership_and_citations(monkeypatch):
    """Verify POST /api/businesses/{id}/qa end-to-end against PostgreSQL with fallback mode."""
    import shutil

    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    monkeypatch.setenv("CREDLENS_AI_DISABLED", "1")
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
