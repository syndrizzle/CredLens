# Frozen Evaluation Data Pack (`eval-pack-v1`)

Task: **P5-03**. Frozen: `2026-11-21`.

All five PDFs and 24 workspace cases in this directory are **fictional manufacturing statements** created strictly for CredLens Phase 5 evaluation (**P5-04**). They are not real business records, lending benchmarks, or authenticated filings.

## Contents

| Artifact | Purpose |
| --- | --- |
| `aster-eval.pdf` (`layout_a`, 3 pages, rupees) | Aster Components (fictional), FY 2023-24 & FY 2024-25 baseline (`+20.00%` growth, `9.00% -> 5.00%` margin, `2.00x` CR, `0.30x` D/E, `5.00x -> 3.00x` coverage). |
| `kaveri-precision.pdf` (`layout_a`, 3 pages, lakhs) | Kaveri Precision Castings (fictional), 3 consecutive years (FY 2022-23, FY 2023-24, FY 2024-25): FY 2023-24 loss (`-5.00%` margin, `-0.50x` coverage) & negative working capital (`INR -3000000.00`), recovery in FY 2024-25 (`+25.00%` growth). |
| `deccan-polymers.pdf` (`layout_a`, 3 pages, thousands) | Deccan Polymer Packaging (fictional), 3 consecutive years (FY 2022-23 to FY 2024-25): fully repaid debt in FY 2024-25 (`0.00x` D/E Supported, `0` interest `Not meaningful` coverage, never `Infinity`). |
| `sahyadri-fasteners.pdf` (`layout_a`, 3 pages, crores) | Sahyadri Fasteners (fictional), 2 gapped years (FY 2022-23 & FY 2024-25): missing FY 2023-24 blocks annual growth only (`Not assessed`), negative equity in FY 2022-23 (`Not meaningful` D/E) recovering to positive equity (`2.00x` D/E) in FY 2024-25. |
| `malwa-gearworks-held-out.pdf` (`layout_c`, 3 pages, thousands) | **Held-out business/layout** — Malwa Precision Gearworks (fictional), FY 2023-24 & FY 2024-25, chronological year columns, alternate label synonyms, absent BS note column, omitted `current_maturities`. Strictly reserved for unbiased **P5-04** evaluation; do not tune extraction against it. |
| `cases.json` | Canonical `AnalysisRequest` payloads and exact Python `Decimal`-checked expected outputs for all 4 evaluation businesses, 1 held-out business, and 19 controlled evidence-error/missing/injection variants. |
| `questions_60.json` | Frozen 60-question evaluation set (`Q01`–`Q60`): exactly 12 questions each for `numerical`, `document`, `missing_input`, `inconsistent_input_period`, and `unsupported_causal_lending`. |
| `manifest.json` | Frozen SHA-256 hashes for all PDFs and JSON artifacts plus `D-02`/`D-05` disclosures. |

## Explicit `D-02` and `D-05` Disclosures

- **HUL public excerpts (`D-05`):** On 2026-11-21, the user selected a fictional-only evaluation pack for `P5-03`. Selected standalone pages from three HUL reporting years are recorded as an explicit deferred gap (`public_excerpts.status = "deferred_by_d05"` in `manifest.json`) rather than fabricated or substituted silently.
- **Reviewer & usability proxy status (`D-02` / `D-05`):** Annotations were authored and verified programmatically by the CredLens team/agent (`independent_checker: "pending_peer_check"`). Usability and financial-definition checks in `P5-04` use student/faculty proxies rather than external business owners or a licensed finance reviewer; financial definitions remain provisional until external finance review (`D-02`).

## Reproduce and Verify

From the repository root:

```bash
backend/.venv/bin/python backend/tests/build_eval_pack.py
cd backend && .venv/bin/python -m pytest -q tests/test_eval_pack.py
```

`build_eval_pack.py` refuses to overwrite any frozen file whose SHA-256 differs from `manifest.json`. `tests/test_eval_pack.py` verifies all SHA-256 hashes, exact deterministic `Decimal` expectations across every case, `pdfplumber` text/table integrity across all 5 PDFs (without calling the financial extractor on held-out `malwa-gearworks-held-out.pdf`), and the exact 5 × 12 question-set invariants.
