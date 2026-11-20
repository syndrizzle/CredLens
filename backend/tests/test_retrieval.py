"""Tests for P4-02 period/page-aware chunking, local MiniLM embeddings, and authorised pgvector retrieval."""

import os
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.auth import SESSION_COOKIE
from app.database import get_engine
from app.documents import inspect_pdf_file
from app.main import app
from app.models import businesses, document_chunks, documents, owners
from app.retrieval import (
    CHUNK_TARGET_TOKENS,
    EMBEDDING_DIM,
    EMBEDDING_MODEL_ID,
    MAX_CHUNKS_PER_DOCUMENT,
    MODEL_MAX_TOKENS,
    build_document_chunks,
    count_model_tokens,
    embed_texts,
    get_embedding_model,
    prepare_embedded_chunks,
)
from app.schemas import DocumentExtractionSnapshot, ExtractedPage, RetrievalRequest
from pdf_helpers import build_minimal_pdf


def test_aster_reference_chunking_respects_minilm_token_limit_and_page_period_metadata():
    aster_pdf = (
        Path(__file__).resolve().parent / "fixtures" / "pdf_corpus" / "aster-reference.pdf"
    ).resolve()
    inspected = inspect_pdf_file(aster_pdf)
    snapshot = DocumentExtractionSnapshot.model_validate(inspected.extraction)
    model = get_embedding_model()

    embedded = prepare_embedded_chunks(snapshot, "aster-reference.pdf", model=model)
    assert len(embedded) >= 3
    pages_seen = {item.chunk.page_number for item in embedded}
    assert pages_seen == {1, 2, 3}

    for idx, item in enumerate(embedded):
        chunk = item.chunk
        assert chunk.chunk_index == idx
        assert chunk.period_years == [2023, 2024]
        assert chunk.section is not None and len(chunk.section) > 0
        # Re-verify against the actual WordPiece tokenizer including [CLS]/[SEP].
        actual_tokens = count_model_tokens(chunk.content, model=model)
        assert actual_tokens == chunk.token_count
        assert 1 <= actual_tokens <= CHUNK_TARGET_TOKENS <= MODEL_MAX_TOKENS
        assert len(item.embedding) == EMBEDDING_DIM
        assert abs(sum(v * v for v in item.embedding) - 1.0) < 1e-4

    # Verify semantic ranking puts page 3 (borrowings note) first for a lease/borrowing query.
    query_vec = embed_texts(
        ["Does the borrowing note exclude leases and count current maturities once?"],
        model=model,
    )[0]
    scored = sorted(
        (
            (sum(a * b for a, b in zip(item.embedding, query_vec)), item.chunk.page_number)
            for item in embedded
        ),
        reverse=True,
    )
    assert scored[0][1] == 3


def test_oversized_narrative_and_pathological_tokens_split_within_model_limit():
    model = get_embedding_model()
    long_note = " ".join(
        f"Note {i}: standalone manufacturing working capital inventory schedule FY 2024-25."
        for i in range(1, 90)
    )
    unbroken_token = "A" * 1200
    text = f"Notes to Standalone Financial Statements FY 2024-25\n{long_note}\n{unbroken_token}"
    snapshot = DocumentExtractionSnapshot(
        schema_version="document-extraction-v2",
        document_sha256="a" * 64,
        layout="unsupported",
        page_count=1,
        extracted_char_count=len(text.replace(" ", "")),
        pages=[
            ExtractedPage(
                page_number=1,
                text=text,
                tables=[],
                statement_title="Notes to Standalone Financial Statements",
                period_context="FY 2024-25",
            )
        ],
        candidates=[],
        issues=[],
    )

    chunks = build_document_chunks(
        snapshot,
        "notes.pdf",
        token_len=lambda value: count_model_tokens(value, model=model),
    )
    assert len(chunks) >= 5
    for chunk in chunks:
        assert chunk.page_number == 1
        assert chunk.period_years == [2024]
        assert count_model_tokens(chunk.content, model=model) <= CHUNK_TARGET_TOKENS
        assert chunk.token_count <= MODEL_MAX_TOKENS


def test_chunk_count_is_bounded_per_document():
    huge_text = "\n".join(
        f"Disclosure paragraph {i}: manufacturing inventory valuation working capital note {i} standalone financial report"
        for i in range(600)
    )
    pages = [
        ExtractedPage(page_number=p, text=huge_text[:45_000], tables=[])
        for p in range(1, 4)
    ]
    snapshot = DocumentExtractionSnapshot(
        schema_version="document-extraction-v2",
        document_sha256="b" * 64,
        layout="unsupported",
        page_count=3,
        extracted_char_count=sum(len(p.text.replace(" ", "")) for p in pages),
        pages=pages,
        candidates=[],
        issues=[],
    )
    chunks = build_document_chunks(
        snapshot,
        "huge.pdf",
        token_len=lambda text: max(1, len(text.split()) + 2),
        max_tokens=32,
    )
    assert len(chunks) == MAX_CHUNKS_PER_DOCUMENT


def test_retrieval_request_schema_enforces_bounds():
    valid = RetrievalRequest(query="  What is the borrowing note?  ", top_k=4, year_start=2024)
    assert valid.query == "What is the borrowing note?"
    assert valid.top_k == 4

    for bad in (
        {"query": "   "},
        {"query": "x" * 501},
        {"query": "ok", "top_k": 0},
        {"query": "ok", "top_k": 7},
        {"query": "ok", "document_id": "not-a-uuid"},
        {"query": "ok", "extra": True},
    ):
        with pytest.raises(Exception):
            RetrievalRequest.model_validate(bad)


@pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database with pgvector",
)
def test_live_pgvector_retrieval_and_pre_retrieval_ownership_isolation(monkeypatch):
    """Verify P4-02 end-to-end on PostgreSQL + pgvector: automatic chunk indexing,
    period/document filtering, strict pre-retrieval owner/business/status isolation,
    and cascade deletion of chunks when a document is removed."""
    import shutil

    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    storage_dir = (
        Path(__file__).resolve().parents[1] / ".storage" / f"test_ret_{uuid4().hex[:8]}"
    )
    monkeypatch.setenv("DOCUMENT_STORAGE_DIR", str(storage_dir))
    get_engine.cache_clear()
    engine = get_engine()
    created_owners: list = []

    aster_pdf = (
        Path(__file__).resolve().parent / "fixtures" / "pdf_corpus" / "aster-reference.pdf"
    ).read_bytes()
    secret_a2_pdf = build_minimal_pdf(
        [
            "Standalone Financial Notes FY 2024-25\nZirconia Foundry secret covenant clause 99182 applies exclusively to Plant Two."
        ]
    )
    secret_b1_pdf = build_minimal_pdf(
        [
            "Standalone Financial Notes FY 2024-25\nObsidian Forge confidential margin note 77412 applies exclusively to Owner B."
        ]
    )

    try:
        alice = TestClient(app)
        bob = TestClient(app)
        anon = TestClient(app)

        reg_a = alice.post(
            "/api/auth/register",
            json={
                "email": f"p402-a-{uuid4().hex[:8]}@example.com",
                "password": "alice-password-123",
            },
        )
        assert reg_a.status_code == 201
        created_owners.append(reg_a.json()["owner_id"])

        reg_b = bob.post(
            "/api/auth/register",
            json={
                "email": f"p402-b-{uuid4().hex[:8]}@example.com",
                "password": "bob-password-12345",
            },
        )
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        blank = {
            "business_name": "Aster Components (fictional)",
            "currency": "INR",
            "basis": "standalone",
            "periods": [
                {
                    "year_start": 2024,
                    "unit": "rupees",
                    "comparable_to_prior": False,
                    "values": {},
                }
            ],
        }
        biz_a1 = alice.post("/api/businesses", json=blank).json()["business_id"]
        biz_a2 = alice.post(
            "/api/businesses", json={**blank, "business_name": "Zirconia Foundry"}
        ).json()["business_id"]
        biz_b1 = bob.post(
            "/api/businesses", json={**blank, "business_name": "Obsidian Forge"}
        ).json()["business_id"]

        doc_a1 = alice.post(
            f"/api/businesses/{biz_a1}/documents",
            files={"file": ("aster-reference.pdf", aster_pdf, "application/pdf")},
        ).json()["id"]
        doc_a2 = alice.post(
            f"/api/businesses/{biz_a2}/documents",
            files={"file": ("zirconia-notes.pdf", secret_a2_pdf, "application/pdf")},
        ).json()["id"]
        doc_b1 = bob.post(
            f"/api/businesses/{biz_b1}/documents",
            files={"file": ("obsidian-notes.pdf", secret_b1_pdf, "application/pdf")},
        ).json()["id"]

        # Confirm chunks were persisted with valid token limits in PostgreSQL.
        with engine.connect() as conn:
            a1_count = conn.execute(
                select(func.count())
                .select_from(document_chunks)
                .where(document_chunks.c.document_id == doc_a1)
            ).scalar_one()
            assert a1_count >= 3

        # 1. Authorised semantic retrieval ranks borrowings note (page 3) top for lease/maturities query.
        ret = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "borrowing note excluding leases and current maturities", "top_k": 3},
        )
        assert ret.status_code == 200
        body = ret.json()
        assert body["embedding_model"] == EMBEDDING_MODEL_ID
        assert body["max_tokens"] == MODEL_MAX_TOKENS
        assert 1 <= len(body["passages"]) <= 3
        assert body["passages"][0]["document_id"] == doc_a1
        assert body["passages"][0]["page_number"] == 3
        assert all(1 <= p["token_count"] <= MODEL_MAX_TOKENS for p in body["passages"])
        assert all(p["document_id"] == doc_a1 for p in body["passages"])

        # 2. Period filter restricts chunks by financial year.
        ret_2024 = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "revenue from operations", "year_start": 2024},
        )
        assert ret_2024.status_code == 200 and len(ret_2024.json()["passages"]) >= 1
        assert all(2024 in p["period_years"] for p in ret_2024.json()["passages"])

        ret_2018 = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "revenue from operations", "year_start": 2018},
        )
        assert ret_2018.status_code == 200 and ret_2018.json()["passages"] == []

        # 3. Pre-retrieval ownership & business isolation: querying exact secret phrases from
        # Bob's business (biz_b1) or Alice's OTHER business (biz_a2) must NEVER return those chunks!
        for secret_query, forbidden_token in (
            ("Obsidian Forge confidential margin note 77412", "77412"),
            ("Zirconia Foundry secret covenant clause 99182", "99182"),
        ):
            res = alice.post(
                f"/api/businesses/{biz_a1}/retrieval",
                json={"query": secret_query, "top_k": 6},
            )
            assert res.status_code == 200
            for passage in res.json()["passages"]:
                assert passage["document_id"] == doc_a1
                assert forbidden_token not in passage["content"]

        # 4. Negative access matrix on POST /api/businesses/{id}/retrieval:
        assert (
            anon.post(f"/api/businesses/{biz_a1}/retrieval", json={"query": "revenue"}).status_code
            == 401
        )
        forged = TestClient(app)
        forged.cookies.set(SESSION_COOKIE, "forged-retrieval-token-1234567890")
        assert (
            forged.post(f"/api/businesses/{biz_a1}/retrieval", json={"query": "revenue"}).status_code
            == 401
        )
        # Cross-owner business -> uniform 404 identical to unknown business UUID.
        r_bob_biz = bob.post(f"/api/businesses/{biz_a1}/retrieval", json={"query": "revenue"})
        r_unknown_biz = bob.post(f"/api/businesses/{uuid4()}/retrieval", json={"query": "revenue"})
        assert r_bob_biz.status_code == 404 and r_unknown_biz.status_code == 404
        assert r_bob_biz.json() == r_unknown_biz.json()

        # Cross-business & cross-owner document_id filter -> uniform 404 identical to unknown doc UUID.
        r_cross_biz_doc = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "covenant", "document_id": doc_a2},
        )
        r_cross_owner_doc = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "margin", "document_id": doc_b1},
        )
        r_unknown_doc = alice.post(
            f"/api/businesses/{biz_a1}/retrieval",
            json={"query": "margin", "document_id": str(uuid4())},
        )
        assert (
            r_cross_biz_doc.status_code
            == r_cross_owner_doc.status_code
            == r_unknown_doc.status_code
            == 404
        )
        assert r_cross_biz_doc.json() == r_cross_owner_doc.json() == r_unknown_doc.json()

        # 5. Non-ready document is excluded from retrieval immediately, and deletion cascades chunks.
        with engine.begin() as conn:
            conn.execute(
                documents.update()
                .where(documents.c.id == doc_a1)
                .values(status="failed", error_code="deletion_pending", error_message="Pending")
            )
        ret_pending = alice.post(
            f"/api/businesses/{biz_a1}/retrieval", json={"query": "revenue"}
        )
        assert ret_pending.status_code == 200 and ret_pending.json()["passages"] == []

        assert alice.delete(f"/api/businesses/{biz_a1}/documents/{doc_a1}").status_code == 200
        with engine.connect() as conn:
            remaining = conn.execute(
                select(func.count())
                .select_from(document_chunks)
                .where(document_chunks.c.document_id == doc_a1)
            ).scalar_one()
            assert remaining == 0
    finally:
        shutil.rmtree(storage_dir, ignore_errors=True)
        with engine.begin() as connection:
            for owner_id in created_owners:
                connection.execute(businesses.delete().where(businesses.c.owner_id == owner_id))
                connection.execute(owners.delete().where(owners.c.id == owner_id))
        engine.dispose()
        get_engine.cache_clear()
