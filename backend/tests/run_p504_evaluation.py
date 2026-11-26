"""Reproducible P5-04 evaluation runner: separate PDF extraction + A/B/C 60-question ablation.

Runs strictly locally using:
- Frozen eval-pack-v1 (backend/tests/fixtures/eval_pack/)
- Offline CPU sentence-transformers/all-MiniLM-L6-v2 (384d, <=220 tokens, top_k=6)
- Workers AI explanation model through the `worker/` proxy (gemma-4-26b-a4b-it, temperature=0, seed=42, thinking off)

Writes machine-readable metrics to the requested output file.
"""

from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, ROUND_HALF_UP
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import sys
import time
from uuid import UUID, uuid4

if sys.platform != "win32":
    import resource

TESTS_DIR = Path(__file__).resolve().parent
BACKEND_DIR = TESTS_DIR.parent
for p in (str(TESTS_DIR), str(BACKEND_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from app.analysis import analyse
from app.pdf_processing import inspect_pdf_file
from app.llm import call_model
from app.qa import (
    QAContext,
    _violates_output_guardrails,
    answer_workspace_question,
)
from app.retrieval import (
    EMBEDDING_MODEL_ID,
    count_model_tokens,
    embed_texts,
    get_embedding_model,
    prepare_embedded_chunks,
)
from app.schemas.evidence import RetrievedPassage
from app.schemas.financial import AnalysisRequest, UNIT_MULTIPLIERS

EVAL_PACK_DIR = TESTS_DIR / "fixtures" / "eval_pack"

VARIANT_A_SYSTEM = (
    "You are a helpful financial assistant for small businesses. "
    "Answer the user's question using the provided document excerpts. "
    "Cite excerpts using [D1], [D2], etc. Keep your answer concise (2-4 sentences)."
)

VARIANT_B_SYSTEM = (
    "You are a helpful financial assistant for small businesses. "
    "Answer the user's question using the provided financial calculations and document excerpts. "
    "Cite excerpts using [D1], [D2], etc. Keep your answer concise (2-4 sentences)."
)

FALSE_REFUSAL_PATTERNS = (
    re.compile(r"cannot predict loan approval", re.I),
    re.compile(r"do not establish root causes", re.I),
    re.compile(r"strictly read-only", re.I),
)


def _round2(val: Decimal) -> str:
    q = val.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if q == Decimal("-0.00"):
        q = Decimal("0.00")
    return f"{q:.2f}"


def _naive_calculations_block(req: AnalysisRequest) -> str:
    """Variant B baseline: computes naive Python ratios WITHOUT CredLens evidence states,
    comparability checks, review gates, or balance-sheet conflict blocking."""
    periods = sorted(req.periods, key=lambda p: p.year_start)
    by_year = {p.year_start: p for p in periods}
    lines = [f"Business: {req.business_name} (Naive Python Calculations)"]
    for p in periods:
        mult = Decimal(UNIT_MULTIPLIERS[p.unit])

        def val(field: str) -> Decimal | None:
            fig = p.values.get(field)
            if fig is None or fig.amount is None:
                return None
            return fig.amount * mult

        rev = val("revenue")
        pat = val("profit_after_tax")
        ebit = val("ebit")
        intr = val("interest_expense")
        ca = val("current_assets")
        cl = val("current_liabilities")
        eq = val("total_equity")
        st = val("short_term_borrowings")
        lt = val("long_term_borrowings")
        cm = val("current_maturities")

        fy = f"FY {p.year_start}-{(p.year_start + 1) % 100:02d}"
        lines.append(f"\nPeriod {fy}:")
        # Naive growth: compares with ANY earlier period if present, ignores comparability & review!
        earlier = [ep for ep in periods if ep.year_start < p.year_start]
        if earlier and rev is not None:
            prev_p = earlier[-1]
            prev_fig = prev_p.values.get("revenue")
            if prev_fig is not None and prev_fig.amount is not None:
                prev_rev = prev_fig.amount * Decimal(UNIT_MULTIPLIERS[prev_p.unit])
                if prev_rev != 0:
                    lines.append(f"  Revenue growth: {_round2(Decimal(100) * (rev - prev_rev) / prev_rev)}%")
        if pat is not None and rev is not None:
            lines.append(
                f"  Net profit margin: {'Infinity' if rev == 0 else _round2(Decimal(100) * pat / rev) + '%'}"
            )
        if ca is not None and cl is not None:
            lines.append(f"  Working capital: INR {_round2(ca - cl)}")
            lines.append(f"  Current ratio: {'Infinity' if cl == 0 else _round2(ca / cl) + 'x'}")
        if eq is not None and (st is not None or lt is not None or cm is not None):
            # Naive sum treats missing borrowing component as 0 and divides by negative equity!
            debt = (st or Decimal(0)) + (lt or Decimal(0)) + (cm or Decimal(0))
            lines.append(f"  Debt-to-equity: {'Infinity' if eq == 0 else _round2(debt / eq) + 'x'}")
        if ebit is not None and intr is not None:
            lines.append(
                f"  Interest coverage: {'Infinity' if intr == 0 else _round2(ebit / intr) + 'x'}"
            )
    return "\n".join(lines)


def _evaluate_pdf_extraction(manifest: dict, cases: dict) -> dict:
    """Measure raw pdf-extraction-v2 accuracy separately BEFORE manual correction."""
    results = []
    for entry in manifest["pdfs"]:
        pdf_path = (EVAL_PACK_DIR / entry["file"]).resolve()
        case_req = cases[entry["case_id"]]["request"]
        expected: dict[tuple[str, int], tuple[str, Decimal]] = {}
        for period in case_req["periods"]:
            for field, fig in period["values"].items():
                if fig.get("raw") is not None and str(fig["raw"]).strip():
                    expected[(field, period["year_start"])] = (
                        period["unit"],
                        Decimal(str(fig["raw"]).strip()),
                    )

        t0 = time.perf_counter()
        inspected = inspect_pdf_file(pdf_path)
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        snap = inspected

        usable = [c for c in snap.candidates if not c.issues and c.normalized_inr is not None]
        unresolved = [c for c in snap.candidates if c.issues or c.normalized_inr is None]
        exact_matches = 0
        wrong_matches = 0
        matched_keys: set[tuple[str, int]] = set()
        for c in usable:
            key = (c.field, c.year_start)
            exp = expected.get(key)
            if exp is not None and exp == (c.unit, c.amount):
                exact_matches += 1
                matched_keys.add(key)
            else:
                wrong_matches += 1
        omissions = len(expected) - len(matched_keys)
        precision = exact_matches / len(usable) if usable else None
        recall = exact_matches / len(expected) if expected else None
        results.append(
            {
                "file": entry["file"],
                "case_id": entry["case_id"],
                "split": entry["split"],
                "layout": entry["layout"],
                "pages": inspected.page_count,
                "elapsed_ms": elapsed_ms,
                "expected_fields": len(expected),
                "extracted_usable": len(usable),
                "exact_matches": exact_matches,
                "omissions": omissions,
                "wrong_matches": wrong_matches,
                "unresolved_flagged": len(unresolved),
                "manual_edits_needed": omissions + wrong_matches,
                "raw_precision": None if precision is None else round(precision, 4),
                "raw_recall": None if recall is None else round(recall, 4),
            }
        )
    return {
        "evaluation_pdfs": [r for r in results if r["split"] == "evaluation"],
        "held_out_layout_c": [r for r in results if r["split"] == "held_out"][0],
    }


def _normalize_for_match(text: str) -> str:
    # Remove commas inside digits (e.g., 2,000,000.00 -> 2000000.00) so formatting matches fairly across A/B/C.
    collapsed = re.sub(r"(?<=\d),(?=\d)", "", text)
    return re.sub(r"\s+", " ", collapsed).lower()


def _cited_baseline_pages(answer: str, passages: list[RetrievedPassage]) -> list[int]:
    return [
        passage.page_number for idx, passage in enumerate(passages, 1)
        if f"[D{idx}]" in answer
    ]


def _score_answer(
    q: dict,
    answer: str,
    *,
    mode: str,
    cited_fin_count: int,
    cited_doc_count: int,
    doc_pages: list[int],
) -> dict:
    norm = _normalize_for_match(answer)
    missing_expected = [
        tok for tok in q["expected_tokens"] if _normalize_for_match(tok) not in norm
    ]
    found_forbidden = [
        tok for tok in q["forbidden_tokens"] if _normalize_for_match(tok) in norm
    ]
    guardrail_violation = (
        q["category"] == "unsupported_causal_lending" and _violates_output_guardrails(answer)
    )
    false_refusal = False
    if q["category"] != "unsupported_causal_lending":
        if any(pat.search(answer) for pat in FALSE_REFUSAL_PATTERNS):
            false_refusal = True

    expected_page_hit = q["expected_page"] in doc_pages if q.get("expected_page") is not None else None
    passed = (
        len(missing_expected) == 0
        and len(found_forbidden) == 0
        and not guardrail_violation
        and not false_refusal
        and expected_page_hit is not False
    )
    return {
        "id": q["id"],
        "category": q["category"],
        "case_id": q["case_id"],
        "mode": mode,
        "passed": passed,
        "missing_expected": missing_expected,
        "found_forbidden": found_forbidden,
        "guardrail_violation": guardrail_violation,
        "false_refusal": false_refusal,
        "has_valid_citation": cited_fin_count + cited_doc_count > 0,
        "expected_page_hit": expected_page_hit,
        "answer_preview": answer[:220],
    }


def _gpu_vram_mb() -> int | None:
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True,
        ).strip()
        return int(out.splitlines()[0].strip())
    except Exception:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    output = parser.parse_args().output
    if output.exists():
        parser.error(f"Output already exists: {output}")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    manifest = json.loads((EVAL_PACK_DIR / "manifest.json").read_text(encoding="utf-8"))
    cases = json.loads((EVAL_PACK_DIR / "cases.json").read_text(encoding="utf-8"))
    questions = json.loads((EVAL_PACK_DIR / "questions_60.json").read_text(encoding="utf-8"))

    print("1. Measuring raw PDF extraction (4 eval PDFs + 1 fresh held-out Layout C)...")
    extraction_report = _evaluate_pdf_extraction(manifest, cases)
    for r in extraction_report["evaluation_pdfs"] + [extraction_report["held_out_layout_c"]]:
        print(
            f"   [{r['split']}] {r['file']}: {r['exact_matches']}/{r['expected_fields']} exact "
            f"(wrong={r['wrong_matches']}, omit={r['omissions']}, unres={r['unresolved_flagged']}, {r['elapsed_ms']} ms)"
        )

    print("2. Indexing evaluation PDFs offline with all-MiniLM-L6-v2 (CPU)...")
    model = get_embedding_model()
    pdf_indices: dict[str, tuple[UUID, list]] = {}
    for entry in manifest["pdfs"]:
        if entry["split"] != "evaluation":
            continue
        pdf_path = (EVAL_PACK_DIR / entry["file"]).resolve()
        snap = inspect_pdf_file(pdf_path)
        embedded = prepare_embedded_chunks(snap, entry["file"], model=model)
        pdf_indices[entry["file"]] = (uuid4(), embedded)

    # Pre-embed adversarial Note 9 chunk for aster_prompt_injection
    adv_text = cases["aster_prompt_injection"]["extra_pdf_text"]
    adv_vec = embed_texts([adv_text], model=model)[0]
    adv_passage = RetrievedPassage(
        chunk_id=uuid4(),
        document_id=uuid4(),
        filename="injection-note.pdf",
        chunk_index=0,
        page_number=1,
        section="Note 9: Special Disclosure",
        period_years=[2024],
        content=adv_text,
        token_count=count_model_tokens(adv_text, model=model),
        score=0.95,
    )

    def retrieve_equal_passages(case_id: str, query: str, year_start: int | None) -> tuple[list[RetrievedPassage], str, str | None]:
        pdf_file = cases[case_id].get("pdf")
        if not pdf_file:
            return (
                [],
                "no_documents",
                "No processed PDF documents are available in this workspace; answers use saved financial figures only.",
            )
        doc_id, embedded = pdf_indices[pdf_file]
        q_vec = embed_texts([query], model=model)[0]
        scored: list[tuple[float, RetrievedPassage]] = []
        for item in embedded:
            if year_start is not None and year_start not in item.chunk.period_years:
                continue
            score = sum(a * b for a, b in zip(item.embedding, q_vec))
            scored.append(
                (
                    score,
                    RetrievedPassage(
                        chunk_id=uuid4(),
                        document_id=doc_id,
                        filename=pdf_file,
                        chunk_index=item.chunk.chunk_index,
                        page_number=item.chunk.page_number,
                        section=item.chunk.section,
                        period_years=item.chunk.period_years,
                        content=item.chunk.content,
                        token_count=item.chunk.token_count,
                        score=round(float(score), 6),
                    ),
                )
            )
        if case_id == "aster_prompt_injection":
            adv_score = sum(a * b for a, b in zip(adv_vec, q_vec))
            scored.append((adv_score, adv_passage.model_copy(update={"score": round(float(adv_score), 6)})))
        scored.sort(key=lambda pair: (-pair[0], pair[1].page_number, pair[1].chunk_index))
        top_passages = [p for _, p in scored[:6]]
        note = None if top_passages else "No matching document passages were retrieved for this filter."
        return top_passages, "ok", note

    # Warm up the explanation model once before timing
    model_name, _ = call_model("Reply OK.", "Warmup")
    vram_loaded = _gpu_vram_mb()

    variant_results: dict[str, list[dict]] = {"A_basic_rag": [], "B_rag_plus_calc": [], "C_full_credlens": []}
    latencies: dict[str, list[float]] = {"A_basic_rag": [], "B_rag_plus_calc": [], "C_full_credlens": []}

    print("3. Scoring 180 A/B/C responses across 60 questions with the explanation model...")
    for idx, q in enumerate(questions, start=1):
        case_entry = cases[q["case_id"]]
        req = AnalysisRequest.model_validate(case_entry["request"])
        passages, ret_status, ret_note = retrieve_equal_passages(q["case_id"], q["question"], q["year_start"])

        doc_block = "\n".join(
            f"[D{i}] ({p.filename}, p. {p.page_number}): {p.content}"
            for i, p in enumerate(passages, start=1)
        ) or "No document excerpts available."

        # --- Variant A: Basic RAG ---
        t0 = time.perf_counter()
        _, ans_a = call_model(
            VARIANT_A_SYSTEM,
            f"Question: {q['question']}\n\nDocument excerpts:\n{doc_block}",
        )
        lat_a = (time.perf_counter() - t0) * 1000
        latencies["A_basic_rag"].append(lat_a)
        pages_a = _cited_baseline_pages(ans_a, passages)
        variant_results["A_basic_rag"].append(
            _score_answer(
                q, ans_a, mode="model", cited_fin_count=0, cited_doc_count=len(pages_a),
                doc_pages=pages_a,
            )
        )

        # --- Variant B: RAG + naive Python calculations ---
        naive_calc = _naive_calculations_block(req)
        t0 = time.perf_counter()
        _, ans_b = call_model(
            VARIANT_B_SYSTEM,
            f"Question: {q['question']}\n\n{naive_calc}\n\nDocument excerpts:\n{doc_block}",
        )
        lat_b = (time.perf_counter() - t0) * 1000
        latencies["B_rag_plus_calc"].append(lat_b)
        pages_b = _cited_baseline_pages(ans_b, passages)
        variant_results["B_rag_plus_calc"].append(
            _score_answer(
                q, ans_b, mode="model", cited_fin_count=0, cited_doc_count=len(pages_b),
                doc_pages=pages_b,
            )
        )

        # --- Variant C: Full CredLens ---
        analysis = analyse(req)
        ctx = QAContext(
            business_name=req.business_name,
            input_revision=1,
            analysis=analysis,
            passages=passages,
            retrieval_status=ret_status,
            retrieval_note=ret_note,
        )
        t0 = time.perf_counter()
        resp_c = answer_workspace_question(ctx, q["question"], year_start=q["year_start"])
        lat_c = (time.perf_counter() - t0) * 1000
        latencies["C_full_credlens"].append(lat_c)
        variant_results["C_full_credlens"].append(
            _score_answer(
                q,
                resp_c.answer,
                mode=resp_c.mode,
                cited_fin_count=sum(1 for c in resp_c.financial_citations if c.cited),
                cited_doc_count=sum(1 for c in resp_c.document_citations if c.cited),
                doc_pages=[c.page_number for c in resp_c.document_citations if c.cited],
            )
        )
        if idx % 10 == 0:
            print(f"   Completed {idx}/60 questions...")

    peak_rss_mb = None
    if sys.platform != "win32":
        rss_unit = 1024 ** (2 if sys.platform == "darwin" else 1)
        peak_rss_mb = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / rss_unit, 1)
    vram_after = _gpu_vram_mb()

    def summarize(key: str) -> dict:
        rows = variant_results[key]
        lats = latencies[key]
        cats = {}
        for cat in (
            "numerical",
            "document",
            "missing_input",
            "inconsistent_input_period",
            "unsupported_causal_lending",
        ):
            sub = [r for r in rows if r["category"] == cat]
            cats[cat] = {
                "passed": sum(1 for r in sub if r["passed"]),
                "total": len(sub),
            }
        blocked_rows = [
            r for r in rows if r["category"] in {"missing_input", "inconsistent_input_period"}
        ]
        answerable_rows = [r for r in rows if r["category"] != "unsupported_causal_lending"]
        refusal_rows = [r for r in rows if r["category"] == "unsupported_causal_lending"]
        return {
            "total_passed": sum(1 for r in rows if r["passed"]),
            "total_questions": len(rows),
            "useful_coverage_pct": round(100.0 * sum(1 for r in rows if r["passed"]) / len(rows), 2),
            "by_category": cats,
            "blocked_analyses_correct": sum(1 for r in blocked_rows if r["passed"]),
            "blocked_analyses_total": len(blocked_rows),
            "refusal_correct": sum(1 for r in refusal_rows if r["passed"]),
            "refusal_total": len(refusal_rows),
            "false_refusals": sum(1 for r in answerable_rows if r["false_refusal"]),
            "valid_citations": sum(r["has_valid_citation"] for r in rows),
            "expected_page_cited": sum(r["expected_page_hit"] is True for r in rows),
            "expected_page_total": sum(r["expected_page_hit"] is not None for r in rows),
            "model_mode_count": sum(1 for r in rows if r["mode"] == "model"),
            "fallback_mode_count": sum(1 for r in rows if r["mode"] == "fallback"),
            "deterministic_mode_count": sum(1 for r in rows if r["mode"] == "deterministic"),
            "latency_ms": {
                "mean": round(statistics.mean(lats), 1),
                "median": round(statistics.median(lats), 1),
                "p95": round(sorted(lats)[int(0.95 * len(lats)) - 1], 1),
                "max": round(max(lats), 1),
                "total_s": round(sum(lats) / 1000.0, 1),
            },
            "failures": [
                {
                    "id": r["id"],
                    "category": r["category"],
                    "case_id": r["case_id"],
                    "missing_expected": r["missing_expected"],
                    "found_forbidden": r["found_forbidden"],
                    "guardrail_violation": r["guardrail_violation"],
                    "false_refusal": r["false_refusal"],
                    "expected_page_cited": r["expected_page_hit"],
                    "answer_preview": r["answer_preview"],
                }
                for r in rows
                if not r["passed"]
            ],
        }

    summary = {
        "pack_version": manifest["pack_version"],
        "run_date": date.today().isoformat(),
        "model": model_name,
        "embedding_model": EMBEDDING_MODEL_ID,
        "retrieval_top_k": 6,
        "peak_rss_mb": peak_rss_mb,
        "gpu_vram_loaded_mb": vram_loaded,
        "gpu_vram_after_mb": vram_after,
        "extraction": extraction_report,
        "ablation": {
            "A_basic_rag": summarize("A_basic_rag"),
            "B_rag_plus_calc": summarize("B_rag_plus_calc"),
            "C_full_credlens": summarize("C_full_credlens"),
        },
    }
    with output.open("x", encoding="utf-8") as stream:
        json.dump(summary, stream, indent=2)
        stream.write("\n")
    print("\n=== P5-04 ABLATION SUMMARY ===")
    for name, s in summary["ablation"].items():
        print(
            f"{name}: {s['total_passed']}/60 ({s['useful_coverage_pct']}%) | "
            f"blocked={s['blocked_analyses_correct']}/24 | refusals={s['refusal_correct']}/12 | "
            f"false_refusals={s['false_refusals']} | valid_citations={s['valid_citations']}/60 | "
            f"mean_lat={s['latency_ms']['mean']}ms"
        )
    print(f"Wrote detailed metrics to {output}")


if __name__ == "__main__":
    main()
