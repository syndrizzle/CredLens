"""Offline tests for bounded Layout A PDF candidate extraction and corpus evaluation."""
from datetime import date
from decimal import Decimal
from pathlib import Path
import hashlib
import json
import os
import pytest

from app.pdf_processing import DocumentRejectError, inspect_pdf_file
from pdf_helpers import inspect_pdf_bytes
from app.pdf_extraction import ExtractionLimitExceeded, build_extraction_snapshot
from app.pdf_format import RawTable
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
from app.schemas.documents import DocumentExtractionSnapshot
from build_pdf_corpus import CORPUS, render_document
from pdf_helpers import build_minimal_pdf

MANIFEST = json.loads((CORPUS / "manifest.json").read_text())
DEVELOPMENT_DOCS = [d for d in MANIFEST["documents"] if d["split"] == "development"]
HELD_OUT_DOCS = [d for d in MANIFEST["documents"] if d["split"] == "held_out"]


def test_clean_aster_reference_matches_all_24_values_without_extra_candidates():
    reference = json.loads((Path(__file__).parent / "fixtures" / "aster_components.json").read_text())["request"]
    doc_entry = next(d for d in DEVELOPMENT_DOCS if d["file"] == "aster-reference.pdf")
    snapshot = inspect_pdf_file(CORPUS / doc_entry["file"])

    assert snapshot.schema_version == "document-extraction-v2"
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
    assert_corpus_candidates(document)


@pytest.mark.skipif(os.getenv("RUN_EXTRACTION_HOLDOUT") != "1", reason="explicit recorded evaluation only")
def test_held_out_exact_source_cells():
    assert len(HELD_OUT_DOCS) == 1
    assert_corpus_candidates(HELD_OUT_DOCS[0])


def assert_corpus_candidates(document):
    path = CORPUS / document["file"]
    snapshot = inspect_pdf_file(path).model_dump(mode="json")

    assert snapshot["document_sha256"] == document["sha256"]
    assert snapshot["layout"] == "layout_a"
    assert snapshot["page_count"] == len(document["pages"])

    expected_candidates = []
    for page_idx, page in enumerate(document["pages"], 1):
        exp_mult = int(page["multiplier"]) if page["multiplier"] is not None else None
        for row_idx, row in enumerate(page["rows"], 2):
            for col_offset, cell in enumerate(row["values"]):
                # v1 annotated both years as conflicting when only the current year differed.
                issues = cell["issues"]
                if document["file"] == "aster-duplicates.pdf" and row["field"] == "interest_expense" and cell["year_start"] == 2023:
                    issues = ["duplicate_match"]
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
                        issues=issues,
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


def test_context_does_not_leak_across_pages_and_unsupported_layouts_fallback_safely():
    # Plain narrative PDF without tables remains readable with unsupported layout diagnostic.
    plain_pdf = build_minimal_pdf(["Standalone statement narrative without a ruled table."])
    snap = inspect_pdf_bytes(plain_pdf)
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
    multi_snap = inspect_pdf_bytes(pdf_bytes)
    p1_cands = [c for c in multi_snap.candidates if c.page_number == 1]
    p2_cands = [c for c in multi_snap.candidates if c.page_number == 2]
    assert len(p1_cands) == 2 and all(not c.issues and c.normalized_inr is not None for c in p1_cands)
    assert len(p2_cands) == 2 and all(
        c.issues == ["missing_basis", "missing_unit"] and c.normalized_inr is None and c.unit is None and c.basis is None
        for c in p2_cands
    )


def test_extraction_resource_bounds_reject_excessive_expansion(tmp_path, monkeypatch):
    import subprocess
    from app import pdf_processing
    from app.pdf_limits import MAX_WORKER_STDOUT_BYTES

    def build(sha, chars, pages, **kwargs):
        return build_extraction_snapshot(
            sha, chars,
            [(number, text, [RawTable(table) for table in tables]) for number, text, tables in pages],
            **kwargs,
        )
    sha = hashlib.sha256(b"test").hexdigest()

    with pytest.raises(ExtractionLimitExceeded, match="Page text"):
        build(sha, 10, [(1, "a" * (MAX_PAGE_TEXT_LENGTH + 1), [])])

    many_pages = [(i, "a" * 8_000, []) for i in range(1, 46)]
    assert sum(len(p[1]) for p in many_pages) > MAX_TOTAL_TEXT_LENGTH
    with pytest.raises(ExtractionLimitExceeded, match="Total document text"):
        build(sha, 10, many_pages)

    with pytest.raises(ExtractionLimitExceeded, match="Tables per page"):
        build(
            sha,
            10,
            [(1, "text", [[["a"]]] * (MAX_TABLES_PER_PAGE + 1))],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table rows"):
        build(
            sha,
            10,
            [(1, "text", [[["a"]] * (MAX_TABLE_ROWS_PER_PAGE + 1)])],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table columns"):
        build(
            sha,
            10,
            [(1, "text", [[["a"] * (MAX_TABLE_COLS + 1)]])],
        )

    with pytest.raises(ExtractionLimitExceeded, match="Table cell length"):
        build(
            sha,
            10,
            [(1, "text", [[["a" * (MAX_CELL_CHARS + 1)]]])],
        )

    rows_pages = [(i, "text", [[["a"]] * 100]) for i in range(1, 22)]
    assert sum(len(p[2][0]) for p in rows_pages) > MAX_TOTAL_TABLE_ROWS
    with pytest.raises(ExtractionLimitExceeded, match="Table rows"):
        build(sha, 10, rows_pages)

    cells_pages = [(i, "text", [[["a"] * 16] * 50]) for i in range(1, 15)]
    assert sum(len(p[2][0]) * 16 for p in cells_pages) > MAX_TOTAL_TABLE_CELLS
    with pytest.raises(ExtractionLimitExceeded, match="Table cells"):
        build(sha, 10, cells_pages)

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
        build(sha, 10, cand_pages, today=date(2026, 11, 19))

    dummy = tmp_path / "dummy.pdf"
    dummy.write_bytes(b"%PDF-1.4")

    # Oversized child stdout is rejected with 422 parser_resource_limit.
    monkeypatch.setattr(
        pdf_processing.subprocess,
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
            pdf_processing.subprocess,
            "run",
            lambda *_a, _b=bad_payload, **_kw: subprocess.CompletedProcess(
                args=[], returncode=0, stdout=_b
            ),
        )
        with pytest.raises(DocumentRejectError) as exc_info:
            inspect_pdf_file(dummy)
        assert exc_info.value.status_code == 503
        assert exc_info.value.code == "parser_unavailable"


def _statement_table(top, title, period, unit, label, value, date_header="31 Mar 2025"):
    from build_pdf_corpus import text
    stream = text(40, top + 54, title) + text(40, top + 36, period) + text(40, top + 18, unit)
    for x in (40, 330, 560):
        stream += f"{x} {top - 52} m {x} {top} l S\n"
    for y in (top, top - 26, top - 52):
        stream += f"40 {y} m 560 {y} l S\n"
    return (stream + text(44, top - 16, "Particulars") + text(350, top - 16, date_header)
            + text(44, top - 42, label) + text(350, top - 42, value)).encode()


def test_source_context_belongs_to_each_table():
    from pdf_helpers import build_pdf
    annual = "Year ended 31 March 2025"
    first = _statement_table(650, "Standalone balance sheet", annual, "Amounts in INR rupees", "Total assets", "50")
    second = _statement_table(420, "Consolidated income statement", annual, "Amounts in INR lakhs", "Revenue from operations", "8")
    third = _statement_table(220, "Standalone profit and loss", annual, "Amounts in INR thousands", "Profit after tax", "9")
    a, b, c = inspect_pdf_bytes(build_pdf([first + second + third])).model_dump(mode="json")["candidates"]
    assert a["normalized_inr"] == "50" and a["table_index"] == 1
    assert b["issues"] == ["conflicting_basis"] and b["unit"] == "lakhs" and b["normalized_inr"] is None
    assert c["normalized_inr"] == "9000" and c["table_index"] == 3


@pytest.mark.parametrize("period,unit,label,value,issue", [
    ("Quarter ended 31 March 2025", "Amounts in INR lakhs", "Revenue from operations", "8", "conflicting_period"),
    ("As at 31 March 2025", "Amounts in INR lakhs", "Revenue from operations", "8", "missing_period"),
    ("Year ended 31 March 2025", "Amounts in CAD thousands", "Revenue from operations", "8", "conflicting_unit"),
    ("Year ended 31 March 2025", "In thousands", "Revenue from operations", "8", "conflicting_unit"),
    ("Year ended 31 March 2025", "Amounts in INR rupees", "Loss after tax", "800", "ambiguous_mapping"),
    ("As at 31 March 2025", "Amounts in INR rupees", "Short-term borrowings", "800", "ambiguous_mapping"),
])
def test_unresolved_financial_meaning(period, unit, label, value, issue):
    from pdf_helpers import build_pdf
    table = _statement_table(600, "Standalone financial statement", period, unit, label, value)
    candidate, = inspect_pdf_bytes(build_pdf([table])).model_dump(mode="json")["candidates"]
    assert issue in candidate["issues"] and candidate["normalized_inr"] is None


def test_explicit_inclusion_overrides_borrowing_exclusion_text():
    from pdf_helpers import build_pdf
    from build_pdf_corpus import text
    table = _statement_table(600, "Standalone borrowing detail", "As at 31 March 2025",
                             "INR rupees", "Short-term borrowings", "800")
    foot = text(40, 150, "Borrowings exclude leases; short-term excludes current maturities.")
    foot += text(40, 120, "Includes leases and current maturities.")
    candidate, = inspect_pdf_bytes(build_pdf([table + foot.encode()])).model_dump(mode="json")["candidates"]
    assert candidate["issues"] == ["ambiguous_mapping"] and candidate["normalized_inr"] is None


def test_duplicate_year_leaves_other_period_usable():
    from pdf_helpers import build_pdf
    pages = [_statement_table(600, "Standalone profit and loss", f"Year ended 31 March {year}",
                             "Amounts in INR rupees", "Revenue from operations", value, f"31 Mar {year}")
             for year, value in [(2023, "3"), (2024, "4"), (2024, "5")]]
    first, second, third = inspect_pdf_bytes(build_pdf(pages)).model_dump(mode="json")["candidates"]
    assert first["normalized_inr"] == "3" and first["issues"] == []
    assert all(c["issues"] == ["conflicting_match"] and c["normalized_inr"] is None for c in (second, third))


def test_snapshot_requires_resolving_source_coordinates_and_cell():
    from pydantic import ValidationError
    import copy
    snapshot = inspect_pdf_file(CORPUS / "aster-reference.pdf").model_dump(mode="json")
    for key, value in [("page_number", 50), ("table_index", 2), ("row_index", 1), ("row_index", 200),
                       ("column_index", 4), ("note", "99"), ("raw", "123"), ("source_row", ["incorrect"]),
                       ("label", "different label"), ("period_header", "different year")]:
        malformed = copy.deepcopy(snapshot)
        malformed["candidates"][0][key] = value
        with pytest.raises(ValidationError):
            DocumentExtractionSnapshot.model_validate(malformed)
