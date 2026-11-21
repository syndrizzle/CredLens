"""Integrity and reproducibility tests for the frozen P5-03 evaluation data pack.

Verifies frozen SHA-256 hashes, exact deterministic Decimal calculations across all
4 fictional businesses + 19 controlled variants + 1 held-out business, 5x12 frozen
question-set invariants, D-02/D-05 disclosure metadata, and pdfplumber source-text/table
readability WITHOUT running financial extraction on the reserved held-out Layout C PDF.
"""

import hashlib
import json
from pathlib import Path

import pdfplumber

from app.analysis import analyse
from app.schemas import AnalysisRequest
from build_eval_pack import (
    EVAL_PACK_DIR,
    PACK_VERSION,
    build_pack_artifacts,
    _compute_expected_summary,
)


def test_eval_pack_frozen_hashes_and_reproducibility():
    manifest = json.loads((EVAL_PACK_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["pack_version"] == PACK_VERSION
    assert manifest["public_excerpts"]["status"] == "deferred_by_d05"
    assert "student/faculty proxies" in manifest["reviewer_and_proxy_disclosure"]["d05_usability_and_review"]

    regenerated = build_pack_artifacts()
    for name, expected_sha in manifest["artifacts"].items():
        disk_bytes = (EVAL_PACK_DIR / name).read_bytes()
        assert hashlib.sha256(disk_bytes).hexdigest() == expected_sha
        assert regenerated[name] == disk_bytes

    assert len(manifest["pdfs"]) == 5
    splits = [p["split"] for p in manifest["pdfs"]]
    assert splits.count("evaluation") == 4
    assert splits.count("held_out") == 1
    for entry in manifest["pdfs"]:
        disk_bytes = (EVAL_PACK_DIR / entry["file"]).read_bytes()
        assert hashlib.sha256(disk_bytes).hexdigest() == entry["sha256"]
        assert regenerated[entry["file"]] == disk_bytes


def test_eval_pack_cases_match_exact_deterministic_engine_outputs():
    cases = json.loads((EVAL_PACK_DIR / "cases.json").read_text(encoding="utf-8"))
    assert {"aster_components", "kaveri_precision", "deccan_polymers", "sahyadri_fasteners", "malwa_gearworks_held_out"} <= set(cases)

    # Verify every case validates cleanly and matches its frozen expected outputs exactly.
    for case_id, entry in cases.items():
        req = AnalysisRequest.model_validate(entry["request"])
        res = analyse(req)
        assert res.rule_version == "financial-rules-v1"
        assert _compute_expected_summary(entry["request"]) == entry["expected"], f"Mismatch in {case_id}"

    # Spot-check key multi-year & edge-case arithmetic independently.
    kaveri = cases["kaveri_precision"]["expected"]
    assert kaveri["2023"]["indicators"]["revenue_growth"]["value_2dp"] == "-10.00"
    assert kaveri["2023"]["indicators"]["net_profit_margin"]["value_2dp"] == "-5.00"
    assert kaveri["2023"]["indicators"]["working_capital"]["value_2dp"] == "-3000000.00"
    assert kaveri["2023"]["indicators"]["interest_coverage"]["value_2dp"] == "-0.50"
    assert kaveri["2024"]["indicators"]["revenue_growth"]["value_2dp"] == "25.00"

    deccan = cases["deccan_polymers"]["expected"]
    assert deccan["2024"]["indicators"]["debt_to_equity"] == {
        "state": "Supported",
        "value_exact": "0",
        "value_2dp": "0.00",
        "reason_codes": [],
    }
    assert deccan["2024"]["indicators"]["interest_coverage"]["state"] == "Not meaningful"

    sahyadri = cases["sahyadri_fasteners"]["expected"]
    assert sahyadri["2022"]["indicators"]["debt_to_equity"]["state"] == "Not meaningful"
    assert sahyadri["2024"]["indicators"]["revenue_growth"]["state"] == "Not assessed"
    assert sahyadri["2024"]["indicators"]["working_capital"]["value_2dp"] == "14000000.00"
    assert sahyadri["2024"]["indicators"]["debt_to_equity"]["value_2dp"] == "2.00"


def test_eval_pack_60_frozen_questions_structure_and_balance():
    cases = json.loads((EVAL_PACK_DIR / "cases.json").read_text(encoding="utf-8"))
    questions = json.loads((EVAL_PACK_DIR / "questions_60.json").read_text(encoding="utf-8"))
    assert len(questions) == 60
    assert [q["id"] for q in questions] == [f"Q{i:02d}" for i in range(1, 61)]

    expected_categories = {
        "numerical",
        "document",
        "missing_input",
        "inconsistent_input_period",
        "unsupported_causal_lending",
    }
    counts = {cat: 0 for cat in expected_categories}
    seen_texts = set()
    for q in questions:
        assert q["category"] in expected_categories
        counts[q["category"]] += 1
        assert q["case_id"] in cases, f"Unknown case_id in {q['id']}: {q['case_id']}"
        assert q["case_id"] != "malwa_gearworks_held_out", "Held-out business stays separate from the 60 dev questions"
        assert q["question"] not in seen_texts, f"Duplicate question text in {q['id']}"
        seen_texts.add(q["question"])
        assert q["annotation_status"] == "team_authored_pending_peer_check"
    assert all(count == 12 for count in counts.values()), counts


def test_eval_pack_pdfs_have_selectable_fictional_text_and_tables():
    """Verify source readability via pdfplumber only (no financial extraction run on held-out PDF)."""
    manifest = json.loads((EVAL_PACK_DIR / "manifest.json").read_text(encoding="utf-8"))
    for entry in manifest["pdfs"]:
        pdf_path = EVAL_PACK_DIR / entry["file"]
        with pdfplumber.open(pdf_path) as pdf:
            assert len(pdf.pages) == entry["page_count"] == 3
            for page in pdf.pages:
                text = page.extract_text() or ""
                assert "FICTIONAL DATA" in text
                assert entry["business_name"] in text
                tables = page.extract_tables() or []
                assert len(tables) == 1 and len(tables[0]) >= 3
