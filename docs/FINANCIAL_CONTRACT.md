# Phase 1: manual-entry financial contract

Task: P1-01. Status: **CONFIRMED for Phase 1 implementation**. Prepared and confirmed: 2026-11-07.

This is the user-confirmed contract for the first usable workflow in [PROJECT_SPEC.md](PROJECT_SPEC.md). It turns the milestone proposal's six formulas into explicit inputs, review behaviour, and test expectations. P1-02 implements request/result schemas and boundary validation; P1-03 implements the calculation engine and API. Forms and results UI remain pending. Financial definitions remain provisional pending a finance reviewer; user confirmation is a product decision, not professional validation.

## First workflow

1. Enter a business name and add one to three completed financial years, or load the explicitly labelled fictional example below.
2. Enter figures in a simple form grouped into P&L, balance sheet, and borrowing detail. No upload is required. Missing figures can stay blank.
3. Review the entered figures, period, and unit. Confirm the present figures together; anything unconfirmed remains unreviewed. Confirmation means the user checked their entry, not that CredLens authenticated it.
4. Analyse and show all six indicators for each year. Growth is assessed only where a comparable preceding year exists. Each result shows its inputs/manual origin, formula, period, unit, evidence state, and next step.
5. Edit a figure and re-analyse. The edit resets that figure's review status and invalidates displayed analysis; stale numbers must not look current. Previously confirmed, unchanged figures stay reviewed.

Keep entry and results in one small workflow using default shadcn components. No sign-in, database, upload, chat, charts, or aggregate score in Phase 1. Display that data is unsaved and resets on reload; loading the fictional example requires confirmation before replacing existing entries.

## Periods, units, and numeric representation

The user confirmed the following defaults on 2026-11-07. Use them for Phase 1; record later revisions explicitly:

- Start with Indian April-March financial years, labelled `FY 2024-25` for `2024-04-01` through `2025-03-31`. Support one to three distinct completed years; reject duplicates and unfinished/future years. Other annual year-end conventions need an explicit follow-up decision.
- Growth compares immediately consecutive years only; never label a two-year interval as annual growth. Standalone reporting and a consistent accounting basis are required. The user confirms comparability; unknown or disputed comparability blocks growth, not the other year's snapshot indicators.
- Currency is INR. One selected unit per year: rupees (`1`), thousands (`1000`), lakhs (`100000`), or crores (`10000000`). Different years may use different units; normalize to INR before comparison. The UI displays unit names beside amounts.
- Preserve plain decimal text (up to 15 digits before the decimal and 2 after), including the sign. Empty/whitespace-only entry is missing; numeric zero is present. Trim outer whitespace for parsing, retain the raw entry, and reject commas, currency symbols, exponent notation, non-finite values, and other malformed input with a field error.
- Transport amounts and calculated values as decimal strings, with missing values represented explicitly as null. Never coerce blanks to zero or use JavaScript floating-point arithmetic to calculate financial values.
- Python uses `Decimal` with precision 34. Normalize by the exact integer unit multiplier. Do not round normalized inputs or intermediate calculations. Ratios repeating in decimal are limited by that arithmetic precision.
- Display normalized money as INR with two decimal places, percentages with two decimal places and `%`, and ratios with two decimal places and `x`. Use decimal `ROUND_HALF_UP` for display only; show original entered amount/unit in the evidence detail. Do not use displayed rounded values as later inputs.
- Changing a year's unit or period invalidates its analysis and resets review for that year's figures. Preserve the entered text and require reconfirmation; never silently rescale existing entries.

## Input dictionary

Business name, period, unit, standalone basis, and the comparability confirmation are context. All financial fields may be missing; each indicator lists its own dependencies. Do not force the user to invent values just to submit an incomplete case.

| Field key | User label / definition | Used by |
| --- | --- | --- |
| `revenue` | Revenue from operations, excluding other income | Growth, net profit margin |
| `profit_after_tax` | Profit or loss after tax for the year | Net profit margin |
| `ebit` | Earnings before interest and tax, explicitly supplied/reviewed; never substitute EBITDA or infer it from PAT alone | Interest coverage |
| `interest_expense` | Interest expense for the period on a consistent basis; do not substitute all finance costs without a supported mapping | Interest coverage |
| `current_assets` | Total current assets at year end | Working capital, current ratio |
| `current_liabilities` | Total current liabilities, including applicable current borrowing maturities | Working capital, current ratio |
| `total_assets` | Total assets at year end | Balance-sheet consistency check |
| `total_liabilities` | All liabilities excluding equity, not just borrowings | Balance-sheet consistency check |
| `total_equity` | Total equity at year end | Debt-to-equity, balance-sheet consistency check |
| `short_term_borrowings` | Interest-bearing short-term borrowings excluding amounts separately entered as current maturities; exclude leases | Debt-to-equity |
| `long_term_borrowings` | Interest-bearing non-current borrowings excluding current maturities; exclude leases | Debt-to-equity |
| `current_maturities` | Current maturities of long-term interest-bearing borrowings, counted here once; exclude leases | Debt-to-equity |

Defined borrowings = the sum of the three borrowing fields. All three must be supplied and reviewed, with explicit `0` where none exist. A missing component means debt-to-equity is not assessed; do not assume missing debt is zero. State in the UI/report that leases are excluded and current maturities must not be entered twice. Never add the whole of current liabilities to borrowings.

PAT, EBIT, and equity may be negative and remain signed. Negative revenue, assets, liabilities, borrowing components, or interest expense are preserved but flagged `Needs review`; dependent findings are withheld pending corrected input or an explicitly revised, finance-reviewed rule. Do not apply `abs()`. Zero revenue/interest/current liabilities and non-positive equity have the formula-specific behaviour below.

Each present value keeps raw entry, parsed decimal, multiplier, normalized INR amount, period/basis, `manual` origin, review state, and revision. New/edited figures start unreviewed. Loaded example figures also require confirmation. Phase 1 has no source page or authenticated reviewer; do not fabricate either. Persist reviewer identity and document references in later phases.

## Calculations and dependencies

Rule version on implementation: `financial-rules-v1`, labelled provisional until finance review. Do not change a formula's meaning without changing its version and its tests.

| Indicator | Inputs / calculation | Validity rule |
| --- | --- | --- |
| Revenue growth | Current and immediately prior comparable `revenue`; `100 * (current - prior) / prior` | Prior revenue must be positive. Missing prior year is `Not assessed`; unresolved comparability is `Needs review`; reviewed zero prior revenue is `Not meaningful`. |
| Net profit margin | `100 * profit_after_tax / revenue` | Reviewed zero revenue is `Not meaningful`. A supported loss produces a negative margin. |
| Working capital | `current_assets - current_liabilities` | Zero liabilities are allowed; negative working capital is a supported INR amount, not a credit judgement. |
| Current ratio | `current_assets / current_liabilities` | Reviewed zero current liabilities are `Not meaningful`, never infinity. |
| Debt-to-equity | `(short_term_borrowings + long_term_borrowings + current_maturities) / total_equity` | Reviewed non-positive equity is `Not meaningful`; zero debt with positive equity is a supported zero ratio. |
| Interest coverage | `ebit / interest_expense` | Missing interest is `Not assessed`; reviewed zero interest is `Not meaningful`; a supported negative EBIT can yield negative coverage. |

No universal good/bad ratio thresholds. Findings explain the observed result or change and suggest a check; they never assert an unsupported cause, approval probability, or financing outcome.

### Consistency checks

- For reviewed total assets, total liabilities, and equity, check `abs(total_assets - total_liabilities - total_equity) <= 0.015 * unit_multiplier` INR. This tolerance is the combined half-step rounding allowance for three amounts entered to two decimal places in the selected unit. Show the tolerance and difference; a passing check does not authenticate a statement.
- If those totals are absent, the balance check is `Not assessed`; do not block otherwise supported indicators. If present but unreviewed, the balance check is `Needs review`.
- A failed balance equation marks that year's balance-sheet consistency `Needs review` and blocks working capital, current ratio, and debt-to-equity pending correction. It does not block independently reviewed P&L findings. When both reviewed values exist, current assets exceeding total assets or current liabilities exceeding total liabilities trigger the same review requirement.
- Show missing cash-flow information as a separate limitation. Cash generation is not assessed in this first workflow; no cash-flow input is required for the six indicators.

### Evidence-state precedence

Evaluate each indicator independently and retain every relevant reason, even when one state takes precedence:

1. `Needs review` if a present required value is unreviewed, conflicting, or has an unresolved sign/basis/comparability issue; also apply relevant balance-sheet inconsistencies above.
2. Otherwise `Not assessed` if any required input or prior comparable period is missing.
3. Otherwise `Not meaningful` if reviewed complete inputs violate the formula's validity rule.
4. Otherwise `Supported`, with the calculated value and its input evidence.

For example, missing interest plus unreviewed EBIT is `Needs review`, listing both tasks. After EBIT is confirmed, it becomes `Not assessed`, requesting interest. Show no numerical ratio for the first three states. A field-level change affects only its dependent indicators; unrelated supported findings remain available on re-analysis.

## Fictional reference company

**Example only: Aster Components (fictional manufacturing business).** Not a real business or a lending benchmark. All amounts below are entered as INR rupees, standalone basis, with consecutive April-March years. Both years are comparable. The expected results assume all present figures have been reviewed; the example-load UI initially leaves them unreviewed.

| Field key | FY 2023-24 | FY 2024-25 |
| --- | --- | --- |
| `revenue` | 10000000.00 | 12000000.00 |
| `profit_after_tax` | 900000.00 | 600000.00 |
| `ebit` | 1500000.00 | 1200000.00 |
| `interest_expense` | 300000.00 | 400000.00 |
| `current_assets` | 4000000.00 | 5000000.00 |
| `current_liabilities` | 2000000.00 | 2500000.00 |
| `total_assets` | 10000000.00 | 12000000.00 |
| `total_liabilities` | 4000000.00 | 5000000.00 |
| `total_equity` | 6000000.00 | 7000000.00 |
| `short_term_borrowings` | 500000.00 | 600000.00 |
| `long_term_borrowings` | 1000000.00 | 1200000.00 |
| `current_maturities` | 300000.00 | 300000.00 |

For internal P&L consistency, fictional tax expense is INR 300,000 and INR 200,000 respectively, with no other adjustments: EBIT minus interest minus tax equals PAT. Tax is supporting fixture context, not a new required form field. Balance sheets balance in both years; reviewed balance differences are exactly zero.

| Expected display | FY 2023-24 | FY 2024-25 |
| --- | --- | --- |
| Revenue growth | Not assessed (no preceding year) | 20.00% |
| Net profit margin | 9.00% | 5.00% |
| Working capital (INR) | 2000000.00 | 2500000.00 |
| Current ratio | 2.00x | 2.00x |
| Debt-to-equity | 0.30x | 0.30x |
| Interest coverage | 5.00x | 3.00x |

Expected supported finding: net profit margin decreased from 9.00% to 5.00%, a decrease of **4.00 percentage points**. Next step: review the P&L and supporting expense detail with an accountant. Do not state a cause from these totals alone.

### Controlled test variants

Change one factor at a time from the reviewed reference case:

| Change | Expected behaviour |
| --- | --- |
| Remove FY 2024-25 interest | Coverage `Not assessed`, requesting interest; the other five current-year indicators remain supported. |
| Set reviewed interest to zero | Coverage `Not meaningful`; no infinity; other indicators unchanged. |
| Unreview FY 2024-25 EBIT | Coverage `Needs review`; reviewing it restores 3.00x. |
| Remove interest and unreview EBIT | Coverage `Needs review` with both reasons; confirming EBIT leaves `Not assessed`. |
| Remove prior year | Growth `Not assessed`; remaining snapshot indicators supported. |
| Make years nonconsecutive | Growth `Not assessed` with a request for the immediately preceding year. |
| Unconfirm otherwise consecutive-year comparability | Growth `Needs review`; snapshot indicators unaffected. |
| Express current-year amounts in lakhs, dividing entered amounts by 100000 | Same normalized values/results after review. Unit changes alone without changing raw entries are not this variant. |
| Remove one borrowing component | Debt-to-equity `Not assessed`, naming that component; no assumption of zero. |
| Set reviewed current liabilities to zero | Current ratio `Not meaningful`; working capital INR 5000000.00. Other inputs stay consistent with the total balance sheet. |
| Set equity to zero and total liabilities to total assets | Debt-to-equity `Not meaningful` without an unrelated balance mismatch. |
| Increase reviewed total liabilities by INR 100 | Balance check and three balance-sheet indicators `Needs review`; P&L findings unaffected. |
| Omit total assets and total liabilities | Balance check `Not assessed`; six indicators remain supported where their direct inputs are present. |

## Completion and handoff

- The user confirmed these defaults on 2026-11-07: flow, April-March restriction, units, input mapping, rounding/tolerance, and state precedence. Decision D-01 is confirmed and P1-01 is complete. Finance-reviewer validation remains pending separately as D-02; do not describe the financial rules as professionally validated.
- Fixture amounts and expected results are checked with independent Python `Decimal`/exact-fraction arithmetic during this task. This is arithmetic verification, not finance-reviewer validation or a test of an implemented engine.
- P1-02 added the [machine-readable request fixture](../backend/tests/fixtures/aster_components.json), initially unreviewed, and [backend/API documentation](../backend/README.md). Keep the fixture and reference values synchronized. P1-03 implemented the expected calculations and controlled variants in [engine tests](../backend/tests/test_analysis.py), including evidence isolation, mixed problems, units, precision, and consistency checks. The backend suite passes 108 tests on 2026-11-10; frontend workflow verification remains pending.
