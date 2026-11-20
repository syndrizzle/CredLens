"""Offline tests for bounded Layout A PDF candidate extraction and corpus evaluation."""
from datetime import date
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import pytest

from app.documents import DocumentRejectError, inspect_pdf_bytes, inspect_pdf_file
from app.pdf_extraction import ExtractionLimitExceeded, build_extraction_snapshot
from app.pdf_limits import (
    MAX_CANDIDATES,
    MAX_CELL_CHARS,
    MAX_PAGE_TEXT_LENGTH,
    MAX_TABLE_COLS,
    MAX_TABLE_ROWS_PER_PAGE,
    MAX_TABLES_PER_PAGE,
    MAX_TOTAL_TABLE_CELLS,
    MAX_TOTAL_TABLE_ROWS,
    MAX_TOTAL_TEXT_LENGTH,
)
from app.schemas import DocumentExtractionSnapshot
from build_pdf_corpus import CORPUS, render_document
from pdf_helpers import build_minimal_pdf

MANIFEST = json.loads((CORPUS / "manifest.json").read_text())
DEVELOPMENT_DOCS = [d for d in MANIFEST["documents"] if d["split"] == "development"]
HELD_OUT_DOCS = [d for d in MANIFEST["documents"] if d["split"] == "held_out"]


def _usable_key(candidate: dict) -> tuple:
    return (
        candidate["page_number"],
        candidate["field"],
        candidate["year_start"],
        candidate["unit"],
        candidate["multiplier"],
        candidate["amount"],
        candidate["normalized_inr"],
    )


def test_clean_aster_reference_matches_all_24_values_without_extra_candidates():
    reference = json.loads((Path(__file__).parent / "fixtures" / "aster_components.json").read_text())["request"]
    doc_entry = next(d for d in DEVELOPMENT_DOCS if d["file"] == "aster-reference.pdf")
    result = inspect_pdf_file(CORPUS / doc_entry["file"])
    snapshot = DocumentExtractionSnapshot.model_validate(result.extraction)

    assert snapshot.schema_version == "document-extraction-v1"
    assert snapshot.document_sha256 == doc_entry["sha256"]
    assert snapshot.layout == "layout_a"
    assert snapshot.page_count == 3
    assert snapshot.issues == []
    assert len(snapshot.candidates) == 24

    usable = [c for c in snapshot.candidates if not c.issues and c.normalized_inr is not None]
    assert len(usable) == 24
    assert all(c.reviewed is False for c in snapshot.candidates)
    assert all(c.basis == "standalone" for c in snapshot.candidates)

    extracted_by_year_field = {
        (c.year_start, c.field): (format(c.amount, "f"), format(c.normalized_inr, "f"), c.unit, c.multiplier)
        for c in usable
    }
    expected_from_reference = {
        (period["year_start"], field): (
            figure["raw"],
            format(Decimal(figure["raw"]), "f"),
            period["unit"],
            1,
        )
        for period in reference["periods"]
        for field, figure in period["values"].items()
    }
    assert extracted_by_year_field == expected_from_reference


@pytest.mark.parametrize("document", DEVELOPMENT_DOCS, ids=lambda d: d["file"])
def test_development_corpus_candidates_issues_and_provenance(document):
    path = CORPUS / document["file"]
    result = inspect_pdf_file(path)
    snapshot = result.extraction

    assert snapshot["document_sha256"] == document["sha256"]
    assert snapshot["layout"] == "layout_a"
    assert snapshot["page_count"] == len(document["pages"])

    expected_candidates = []
    for page_idx, page in enumerate(document["pages"], 1):
        exp_mult = int(page["multiplier"]) if page["multiplier"] is not None else None
        for row_idx, row in enumerate(page["rows"], 2):
            for col_offset, cell in enumerate(row["values"]):
                expected_candidates.append(
                    dict(
                        page_number=page_idx,
                        table_index=1,
                        row_index=row_idx,
                        column_index=col_offset + 3,
                        field=row["field"],
                        label=row["label"],
                        note=row["note"],
                        raw=cell["raw"],
                        period_header=page["headers"][col_offset + 2],
                        year_start=cell["year_start"],
                        unit=page["unit"],
                        multiplier=exp_mult,
                        basis="standalone",
                        amount=cell["amount"],
                        normalized_inr=cell["normalized_inr"],
                        reviewed=False,
                        issues=cell["issues"],
                    )
                )

    actual_candidates = [
        {key: candidate[key] for key in expected_candidates[0]}
        for candidate in snapshot["candidates"]
    ]
    assert actual_candidates == expected_candidates
    for candidate in snapshot["candidates"]:
        assert candidate["source_row"][0] == candidate["label"]
        assert candidate["source_row"][1] == candidate["note"]
        assert candidate["source_context"]
        if candidate["issues"]:
            assert candidate["normalized_inr"] is None
        else:
            assert candidate["normalized_inr"] is not None


def test_raw_extraction_precision_recall_and_held_out_evaluation():
    # 1. Measure development split raw precision/recall before any manual correction.
    dev_expected_usable = 0
    dev_extracted_usable = 0
    dev_exact_matches = 0
    dev_expected_unresolved = 0
    dev_exact_unresolved = 0

    for doc in DEVELOPMENT_DOCS:
        snap = inspect_pdf_file(CORPUS / doc["file"]).extraction
        exp_usable = []
        exp_unresolved = []
        for p_idx, p in enumerate(doc["pages"], 1):
            mult = int(p["multiplier"]) if p["multiplier"] is not None else None
            for r_idx, r in enumerate(p["rows"], 2):
                for c_idx, c in enumerate(r["values"], 3):
                    entry = (p_idx, r_idx, c_idx, r["field"], c["year_start"], p["unit"], mult, c["amount"], c["normalized_inr"], tuple(c["issues"]))
                    if not c["issues"]:
                        exp_usable.append(entry)
                    else:
                        exp_unresolved.append(entry)
        act_usable = [
            (c["page_number"], c["row_index"], c["column_index"], c["field"], c["year_start"], c["unit"], c["multiplier"], c["amount"], c["normalized_inr"], tuple(c["issues"]))
            for c in snap["candidates"]
            if not c["issues"] and c["normalized_inr"] is not None
        ]
        act_unresolved = [
            (c["page_number"], c["row_index"], c["column_index"], c["field"], c["year_start"], c["unit"], c["multiplier"], c["amount"], c["normalized_inr"], tuple(c["issues"]))
            for c in snap["candidates"]
            if c["issues"]
        ]
        dev_expected_usable += len(exp_usable)
        dev_extracted_usable += len(act_usable)
        dev_exact_matches += sum(1 for item in act_usable if item in exp_usable)
        dev_expected_unresolved += len(exp_unresolved)
        dev_exact_unresolved += sum(1 for item in act_unresolved if item in exp_unresolved)

    assert dev_expected_usable == 97
    assert dev_extracted_usable == 97
    assert dev_exact_matches == 97
    assert dev_expected_unresolved == 51
    assert dev_exact_unresolved == 51

    # 2. Measure held-out split (Birch Manufacturing, Layout B) without rule adjustments.
    assert len(HELD_OUT_DOCS) == 1
    held_out = HELD_OUT_DOCS[0]
    ho_snap = inspect_pdf_file(CORPUS / held_out["file"]).extraction
    ho_exp_usable = [
        (p_idx, r["field"], c["year_start"], p["unit"], int(p["multiplier"]), c["amount"], c["normalized_inr"])
        for p_idx, p in enumerate(held_out["pages"], 1)
        for r in p["rows"]
        for c in r["values"]
        if not c["issues"]
    ]
    ho_act_usable = [
        _usable_key(c)
        for c in ho_snap["candidates"]
        if not c["issues"] and c["normalized_inr"] is not None
    ]
    assert len(ho_exp_usable) == 20
    assert len(ho_act_usable) == 20
    assert ho_act_usable == ho_exp_usable
    assert [c for c in ho_snap["candidates"] if c["issues"]] == []
    # Absent fields (interest_expense and current_maturities) remain absent, never zero.
    extracted_fields = {c["field"] for c in ho_snap["candidates"]}
    assert "interest_expense" not in extracted_fields
    assert "current_maturities" not in extracted_fields


def test_context_does_not_leak_across_pages_and_unsupported_layouts_fallback_safely():
    # Plain narrative PDF without tables remains readable with unsupported layout diagnostic.
    plain_pdf = build_minimal_pdf(["Standalone statement narrative without a ruled table."])
    res = inspect_pdf_bytes(plain_pdf)
    snap = DocumentExtractionSnapshot.model_validate(res.extraction)
    assert snap.layout == "unsupported"
    assert snap.candidates == []
    assert snap.issues == ["unsupported_layout"]
    assert snap.pages[0].issues == ["unsupported_layout"]

    # Page 1 has full context; Page 2 omits unit and standalone basis. Context must not carry across pages.
    multi_page_doc = {
        "business": "Aster Components (fictional)",
        "split": "development",
        "pages": [
            {
                "title": "Standalone profit and loss",
                "context": [
                    "Years ended 31 March 2025 and 31 March 2024; full April-March years.",
                    "Amounts in INR rupees.",
                ],
                "headers": ["Particulars", "Note", "31 Mar 2025", "31 Mar 2024"],
                "rows": [
                    {
                        "label": "Revenue from operations",
                        "note": "11",
                        "values": [{"raw": "12000000.00"}, {"raw": "10000000.00"}],
                    }
                ],
            },
            {
                "title": "Balance sheet summary",
                "context": ["Years ended 31 March 2025 and 31 March 2024; full April-March years."],
                "headers": ["Particulars", "Note", "31 Mar 2025", "31 Mar 2024"],
                "rows": [
                    {
                        "label": "Total assets",
                        "note": "12",
                        "values": [{"raw": "12000000.00"}, {"raw": "10000000.00"}],
                    }
                ],
            },
        ],
    }
    pdf_bytes = render_document(multi_page_doc)
    multi_snap = DocumentExtractionSnapshot.model_validate(inspect_pdf_bytes(pdf_bytes).extraction)
    p1_cands = [c for c in multi_snap.candidates if c.page_number == 1]
    p2_cands = [c for c in multi_snap.candidates if c.page_number == 2]
    assert len(p1_cands) == 2 and all(not c.issues and c.normalized_inr is not None for c in p1_cands)
    assert len(p2_cands) == 2 and all(
        c.issues == ["missing_basis", "missing_unit"] and c.normalized_inr is None and c.unit is None and c.basis is None
        for c in p2_cands
    )


def test_extraction_resource_bounds_reject_excessive_expansion(tmp_path, monkeypatch):
    import subprocess
    from app import documents
    from app.pdf_limits import MAX_WORKER_STDOUT_BYTES

    sha = hashlib.sha256(b"test").hexdigest()

    with pytest.raises(ExtractionLimitExceeded, match="Page text"):
        build_extraction_snapshot(sha, 10, [(1, "a" * (MAX_PAGE_TEXT_LENGTH + 1), [])])

    many_pages = [(i, "a" * 8_000, []) for i in range(1, 46)]
    assert sum(len(p[1]) for p in many_pages) > MAX_TOTAL_TEXT_LENGTH
    with pytest.raises(ExtractionLimitExceeded, match="Total document text"):
        build_extraction_snapshot(sha, 10, many_pages)

    with pytest.raises(ExtractionLimitExceeded, match="Tables per page"):
        build_extraction_snapshot(
            sha,
            10,
            [(1, "text", [[["a"]]] * (MAX_TABLES_PER_PAGE + 1))],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table rows"):
        build_extraction_snapshot(
            sha,
            10,
            [(1, "text", [[["a"]] * (MAX_TABLE_ROWS_PER_PAGE + 1)])],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table columns"):
        build_extraction_snapshot(
            sha,
            10,
            [(1, "text", [[["a"] * (MAX_TABLE_COLS + 1)]])],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table cell length"):
        build_extraction_snapshot(
            sha,
            10,
            [(1, "text", [[["a" * (MAX_CELL_CHARS + 1)]]])],
        )

    rows_pages = [(i, "text", [[["a"]] * 100]) for i in range(1, 22)]
    assert sum(len(p[2][0]) for p in rows_pages) > MAX_TOTAL_TABLE_ROWS
    with pytest.raises(ExtractionLimitExceeded, match="Table rows"):
        build_extraction_snapshot(sha, 10, rows_pages)

    cells_pages = [(i, "text", [[["a"] * 16] * 50]) for i in range(1, 15)]
    assert sum(len(p[2][0]) * 16 for p in cells_pages) > MAX_TOTAL_TABLE_CELLS
    with pytest.raises(ExtractionLimitExceeded, match="Table cells"):
        build_extraction_snapshot(sha, 10, cells_pages)

    header = ["Particulars", "Note", "31 Mar 2025", "31 Mar 2024"]
    cand_table = [header] + [["Revenue from operations", "1", "100.00", "90.00"]] * 130
    cand_pages = [
        (
            1,
            "Standalone profit and loss\nYears ended 31 March 2025 and 31 March 2024\nAmounts in INR rupees.",
            [cand_table],
        ),
        (
            2,
            "Standalone profit and loss\nYears ended 31 March 2025 and 31 March 2024\nAmounts in INR rupees.",
            [cand_table],
        ),
    ]
    assert 130 * 2 * 2 > MAX_CANDIDATES
    with pytest.raises(ExtractionLimitExceeded, match="candidates exceed budget"):
        build_extraction_snapshot(sha, 10, cand_pages, today=date(2026, 11, 19))

    dummy = tmp_path / "dummy.pdf"
    dummy.write_bytes(b"%PDF-1.4")

    # Oversized child stdout is rejected with 422 parser_resource_limit.
    monkeypatch.setattr(
        documents.subprocess,
        "run",
        lambda *_a, **_kw: subprocess.CompletedProcess(
            args=[], returncode=0, stdout=b"x" * (MAX_WORKER_STDOUT_BYTES + 1)
        ),
    )
    with pytest.raises(DocumentRejectError) as exc_info:
        inspect_pdf_file(dummy)
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "parser_resource_limit"

    # Malformed or missing extraction snapshot from child is rejected with 503 parser_unavailable.
    for bad_payload in (
        b'{"pages": 1, "chars": 10}',
        b'{"pages": 1, "chars": 10, "extraction": {"schema_version": "bad"}}',
    ):
        monkeypatch.setattr(
            documents.subprocess,
            "run",
            lambda *_a, _b=bad_payload, **_kw: subprocess.CompletedProcess(
                args=[], returncode=0, stdout=_b
            ),
        )
        with pytest.raises(DocumentRejectError) as exc_info:
            inspect_pdf_file(dummy)
        assert exc_info.value.status_code == 503
        assert exc_info.value.code == "parser_unavailable"
