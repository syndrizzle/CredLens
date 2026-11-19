"""Check frozen source fixtures, without invoking or measuring a financial extractor."""
import hashlib
import json
from decimal import Decimal
from pathlib import Path

import pdfplumber
import pytest

from build_pdf_corpus import CORPUS, render_document
from app.documents import inspect_pdf_file

MANIFEST = json.loads((CORPUS / "manifest.json").read_text())


@pytest.mark.parametrize("document", MANIFEST["documents"], ids=lambda d: d["file"])
def test_frozen_pdf_bytes_source_cells_and_annotations(document):
    path = CORPUS / document["file"]
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == document["sha256"]
    assert render_document(document) == data
    with pdfplumber.open(path) as pdf:
        assert len(pdf.pages) == len(document["pages"])
        for number, (page, expected) in enumerate(zip(pdf.pages, document["pages"]), 1):
            text = page.extract_text()
            assert "FICTIONAL DATA" in text
            assert document["business"] in text
            assert expected["title"] in text
            assert f"Page {number}" in text
            for context in expected["context"]:
                assert context in text
            tables = page.extract_tables()
            assert len(tables) == 1
            assert tables[0][0] == expected["headers"]
            assert tables[0][1:] == [
                [row["label"], row["note"]] + [cell["raw"] for cell in row["values"]]
                for row in expected["rows"]
            ]
            for row in expected["rows"]:
                for cell in row["values"]:
                    if cell["issues"]:
                        assert cell["normalized_inr"] is None
                    else:
                        # Annotations are checked against source tokens, never matcher output.
                        token = cell["raw"].replace(",", "")
                        if token.startswith("(") and token.endswith(")"):
                            token = "-" + token[1:-1]
                        assert Decimal(token) == Decimal(cell["amount"])
                        assert Decimal(cell["normalized_inr"]) == Decimal(token) * Decimal(expected["multiplier"])
    pages, chars = inspect_pdf_file(path)
    assert pages == len(document["pages"]) and chars > 0


def test_reference_annotations_match_existing_case_and_cover_all_fields():
    reference = json.loads((Path(__file__).parent / "fixtures" / "aster_components.json").read_text())["request"]
    document = next(d for d in MANIFEST["documents"] if d["file"] == "aster-reference.pdf")
    actual = {
        (cell["year_start"], row["field"]): cell["amount"]
        for page in document["pages"] for row in page["rows"] for cell in row["values"]
    }
    expected = {
        (period["year_start"], field): figure["raw"]
        for period in reference["periods"] for field, figure in period["values"].items()
    }
    assert len(actual) == 24 and actual == expected
    for year in (2023, 2024):
        assert Decimal(actual[year, "total_assets"]) == Decimal(actual[year, "total_liabilities"]) + Decimal(actual[year, "total_equity"])


def test_corpus_split_coverage_and_review_claims():
    documents = MANIFEST["documents"]
    held_out = [d for d in documents if d["split"] == "held_out"]
    assert len(held_out) == 1
    assert held_out[0]["layout"] == "B"
    assert {d["layout"] for d in documents if d["split"] == "development"} == {"A"}
    assert held_out[0]["business"] not in {d["business"] for d in documents if d["split"] == "development"}
    assert MANIFEST["independent_checker"] is None
    assert MANIFEST["extractor_evaluation_runs"] == []
    issues = {issue for d in documents for p in d["pages"] for r in p["rows"] for c in r["values"] for issue in c["issues"]}
    assert issues == {"missing_value", "invalid_amount", "ambiguous_mapping", "missing_unit", "conflicting_unit", "missing_period", "conflicting_period", "duplicate_match", "conflicting_match"}
    assert len({d["file"] for d in documents}) == len(documents) == 13
    assert {p.name for p in CORPUS.glob("*.pdf")} == {d["file"] for d in documents}
