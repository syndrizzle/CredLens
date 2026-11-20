# P3-02: digital-PDF candidate extraction plan

Prepared: 2026-11-19. Planning task: P3-02-P1. Implementation: P3-02, completed 2026-11-19.

The user selected **fictional PDFs first**. This plan uses the existing [financial contract](FINANCIAL_CONTRACT.md) and `backend/tests/fixtures/aster_components.json`; it does not claim support for public financial statements. The planning task created no extraction code or corpus. P3-02-FX subsequently froze the [fictional fixture corpus](../backend/tests/fixtures/pdf_corpus/README.md) on 2026-11-19; P3-02 implemented bounded extraction (`app/pdf_extraction.py`, `app/pdf_worker.py`) and protected extraction snapshots (`documents.extraction`, migration `e519a47c8b14`, `app/documents.py`, `app/main.py`).

## Scope and flow

Upload a PDF to an authenticated saved workspace -> run bounded validation and extraction -> retain page text, table rows, unreviewed figure candidates, and explicit issues -> expose the extraction through an owner-protected read endpoint. Unsupported layouts remain readable digital PDFs with no usable candidates and an explanation to use manual entry. File-validation/resource failures retain the existing failed/retry/removal lifecycle.

P3-03 adds page-linked candidate selection, correction, and confirmation. P3-02 must never write extracted amounts into `figures`, confirm values, change workspace periods/units, advance input revisions, or invalidate financial analyses. Existing manual-entry and saved-workspace behaviour continues. Candidate issues are extraction diagnostics, distinct from the four financial evidence states.

## Corpus before tuning

Create and freeze these digital, selectable-text PDFs plus independently checked expected annotations before writing matching rules. Include a visible fictional-data label on every page. Record file hashes, business identity, layout ID, split, expected page/row/period/unit/field/value, and annotation author/checker status in a manifest. Do not claim independent review if only an agent has checked the data.

| Split | Business/layout | Content and purpose |
| --- | --- | --- |
| Development | Aster Components, layout A | Existing two-year reference case; explicitly labelled standalone P&L, balance sheet, and borrowing detail. Rupees; current/prior columns; explicit dates and unit headers; all 12 existing fields for each year. |
| Development | Aster Components, layout A variants | Parenthesized loss, Indian/international grouping, explicit zeros, blank/dash missing interest, reversed year columns, missing/contradictory unit or period, duplicate/conflicting rows, note-reference digits, and misleading finance-cost/EBITDA labels. Record expected omissions/issues separately. |
| Held out | A second fictional manufacturing business, layout B | Different figures, lakhs, different row order/spacing and year-column order, with some absent fields. Reserve PDF and annotations before tuning; do not use its values, labels, or extraction output to adjust matching rules. |

Layout A is the initial supported layout: a simple ruled table, one label column, an optional explicitly headed note-reference column, and one or two annual amount columns. Explicit full-year dates establish completed April–March years; balance-sheet dates establish year-end snapshots. Unit and standalone context must be explicit. Carry context only within an explicitly identified statement/table, not across unrelated pages. Other layouts use manual fallback until measured support is added.

The held-out layout tests generalization and safe fallback; it is not promised to extract fully. Run it only after freezing the first extractor version and development results. Record every run and failure. Once used for tuning it becomes development data and needs a replacement holdout before the next unbiased evaluation. This is an early synthetic extraction check, not the final P5-03 evaluation pack or evidence of real-world accuracy.

## Candidate and ambiguity contract

Retain a versioned document extraction snapshot tied to the stored document ID/hash. For each page keep its physical 1-based PDF page number, extracted text, and bounded table rows/cells. A candidate keeps:

- Existing financial field key, exact source label, raw value token, source row/context, table/row/column reference, and page number.
- Explicit period/date header and resolved year, unit header and exact multiplier, and standalone context. Unknown/conflicting context remains explicit, with no usable normalized amount.
- Parsed decimal text and exact normalized INR text where valid, preserving the original printed token. No floating-point arithmetic or rounding of source values.
- Unreviewed status and issues such as missing period/unit, ambiguous mapping, invalid amount, or conflicting duplicates. No probability/confidence score.

Only map labels whose meaning agrees with the existing input dictionary. Revenue from operations is not total income; EBIT is not EBITDA; finance costs are not automatically interest expense; total equity and liabilities is not total liabilities. Require explicit borrowing-component labels excluding leases/current-maturity overlap; ambiguous totals remain unmapped. Do not derive EBIT, sum liabilities, or infer missing debt components. Retain unmatched text/rows for source inspection.

Recognize correctly grouped Indian/international comma numbers, plain decimals with at most two decimal places, and parenthesized negative amounts. Keep signs, explicit zero, and missing tokens distinct. Malformed grouping, excess precision, or unsupported notation gets an issue instead of silent coercion. Missing rows/tokens never become zero. Column position alone cannot supply a year; note references never become amounts. Duplicate matches must remain visible and unresolved rather than selecting the first. Comparability remains an explicit user review in P3-03.

## Small implementation boundary

1. Add fictional fixtures/annotations and freeze their manifest; verify them against the existing reference case before matcher work.
2. Add one extraction module called inside `app/pdf_worker.py`'s bounded child. Reuse its lazy page traversal and resource limits; do not parse the PDF again in the API process. Preserve existing inspection callers or update every caller/test together. Bound retained text (including whitespace), rows/cells, candidates, and serialized output as well as existing decoded-stream, time, memory, page, and character limits. Check the installed pdfplumber APIs before use.
3. Add a nullable JSONB extraction snapshot on `documents` through an Alembic migration; existing ready documents have no extraction and remain viewable. Publish validated snapshot plus ready status in the same final commit. Processing, failure, interruption, and deletion-pending states expose no current snapshot. Retrying replaces the snapshot only on success; old ready documents need an explicit owner-gated extraction action reusing the existing job lock, without re-upload or relaxing failed-document retry semantics.
4. Add `GET /api/businesses/{business_id}/documents/{document_id}/extraction` and an owner-gated processing action for existing ready documents. Return explicit extraction availability for legacy/pending/failed documents; enforce owner/business/document matching before any busy/state response. Keep full source text out of document listings/workspace summaries and logs. Validate child output structure and bounds before persistence. Removing a document removes its snapshot with the row.
5. Add targeted offline extraction tests, live disposable-branch lifecycle/access/migration checks, and backend API documentation. Update `PROJECT_SPEC.md` and `PERSISTENCE_PLAN.md`. No frontend, financial-origin schema, model, dependency, or retrieval changes in P3-02; P3-03 owns integrating document origins into reviewed figures and revisions.

Affected files: `backend/app/pdf_worker.py`, `documents.py`, `schemas.py`, `models.py`, `main.py`, one new extraction module and migration, extraction fixtures/tests, existing document/limit/auth tests as needed, and backend/persistence/tracker docs. Check all inspection/processing callers before editing. Existing manual-only `FinancialValue.origin`, calculation requests, frontend payload validators, saved runs, and revision snapshots remain unchanged in this step.

## Acceptance checks

- Clean Aster layout: exact field, year, unit, sign, normalized value, and source-page match for all 24 annotated values; no extra usable candidates. Compare annotations against the existing reference JSON, not extractor output.
- Variants: reproduce annotated omissions/issues, never guess ambiguous amounts/years/units, retain raw context, and leave all candidates unreviewed. Missing interest must not suppress unrelated candidates. Extraction cannot change stored figures or financial runs.
- Report raw candidate precision/recall with counts and exact-match rules before correction; score field/year/unit/value/page together. Report omissions, wrong matches, unresolved candidates, unsupported layouts, and held-out results separately. Do not claim a real-world accuracy threshold from synthetic data. Manual correction effort belongs to P3-03/04.
- Resource regressions: table/text/output expansion remains bounded in the child; malformed output, timeout, crash, and final-commit failure cannot publish partial extraction. Keep ingress, storage permissions, lazy page limits, observer-visible processing, active-owner locking, and crash/retry/removal regressions passing.
- Security/persistence: anonymous, other-owner, wrong-business, and unknown IDs fail consistently for extraction reads/actions; legacy-ready documents remain usable; migration upgrade/downgrade and metadata check pass on a disposable branch; removal clears derived snapshots. Verify no financial revision or review-state changes.
- Run relevant Pytest suites and `pip check`; record live skips honestly. Frontend lint/build are required if implementation touches frontend files. No application checks are claimed for this documentation-only plan.

## Measured raw extraction results (`pdf-extraction-v1`, before manual correction)

Exact-match scoring rule: a usable candidate (`normalized_inr is not None` and `issues == []`) counts as a true positive only when `(page_number, table_index, row_index, column_index, field, year_start, unit, multiplier, raw, amount, normalized_inr)` all match the frozen manifest annotation and `reviewed is False`.

| Split / subset | PDFs / pages | Expected usable | Extracted usable | Exact matches | Omissions | Wrong matches | Raw precision | Raw recall | Unresolved flagged (`normalized_inr=None`) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clean Aster reference (`aster-reference.pdf`, Layout A) | 1 / 3 | 24 | 24 | 24 | 0 | 0 | 24/24 (`100.00%`) | 24/24 (`100.00%`) | 0 |
| Development corpus total (12 Layout A PDFs) | 12 / 18 | 97 | 97 | 97 | 0 | 0 | 97/97 (`100.00%`) | 97/97 (`100.00%`) | 51 / 51 expected (`1` blank `missing_value`, `1` dash `missing_value`, `3` `invalid_amount`, `6` `ambiguous_mapping`, `8` `missing_unit`, `8` `conflicting_unit`, `8` `missing_period`, `8` `conflicting_period`, `4` `duplicate_match`, `4` `conflicting_match`) |
| Held-out fixture (`birch-held-out.pdf`, Birch Fabrication, Layout B, run once after freezing `pdf-extraction-v1`) | 1 / 3 | 20 | 20 | 20 | 0 | 0 | 20/20 (`100.00%`) | 20/20 (`100.00%`) | 0 (absent `interest_expense` and `current_maturities` remained absent and were not coerced to zero) |
| Unsupported narrative/two-column layout fallback (synthetic check) | 1 / 1 | 0 | 0 | 0 | 0 | 0 | N/A (`0` emitted) | N/A (`0` expected) | 0 (`layout="unsupported"`, `supported_layout=False`, manual-entry guidance message) |

These results measure synthetic digital-PDF fixture extraction before user correction and do not establish a real-world accuracy threshold on public financial statements. Because `birch-held-out.pdf` was evaluated once without rule adjustments, it remains a clean single-run evaluation for `pdf-extraction-v1`; any future rule tuning that uses Birch's output will require a new held-out fixture before the next unbiased evaluation. D-02 finance-reviewer validation remains open.
