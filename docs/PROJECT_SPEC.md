# CredLens: project spec and progress tracker

Last updated: 2026-11-07

This is the living implementation plan. [AGENTS.md](../AGENTS.md) defines how to work; this file defines what to build, its completion criteria, and current progress. The [milestone-1 proposal](CredLens-Milestone-One-Report.pdf), especially sections 7, 8, 10, and 12, supplies the baseline requirements. Later explicit user decisions take precedence; record changes here.

## Start here

- **Current stage:** Phase 0, foundation partially complete. No product workflow is implemented.
- **Active implementation task:** none. This planning task is complete; product implementation has not started.
- **Next task:** **P0-03**, restore a working frontend build and record the checks.
- **Next product task:** **P1-01**, settle the manual-entry input/formula contract and prepare one fictional company case with known answers.
- **First usable milestone:** enter financial figures, confirm them, and see six indicator results with sources, blocked-input explanations, and useful next steps. This works without PDFs or an LLM.

Start with the build repair, then complete Phase 1 in small tasks. Do not build a landing page, chat interface, or upload pipeline before the core financial workflow works.

### Verified repository baseline

| Area | Observed on 2026-11-07 | Evidence |
| --- | --- | --- |
| Frontend foundation | React/TypeScript/Vite, Tailwind, Base Nova shadcn preset, Hugeicons, theme tokens and Bun lockfile exist | `package.json`, `components.json`, `src/index.css`, `bun.lock` |
| Application | Placeholder `Hello World`; button is the only installed UI component | `src/App.tsx`, `src/components/ui/button.tsx` |
| Agent guidance | Repository instructions, host adapters, and Ponytail license exist | `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/project.mdc`, `.github/copilot-instructions.md` |
| Frontend lint | Completes with one `react(only-export-components)` warning on `buttonVariants` | `bun run lint`; warning at `src/components/ui/button.tsx:57` |
| Frontend build | Fails: TS5102, `baseUrl` has been removed | `bun run build`; error at `tsconfig.app.json:24` |
| Backend/data/AI | No backend, database schema, financial rules, uploads, retrieval, or reports implemented | Repository file inventory |

These observations do not certify runtime behaviour. Update them when implementation or verification changes them.

## How every agent maintains this file

1. Before editing, read this file and `AGENTS.md`, inspect the real code and Git changes, and choose the next task whose dependencies are satisfied. Do not assume a `DONE` entry replaces code inspection.
2. Mark the selected task `IN_PROGRESS`; record its ID and scope under **Start here**. Work on one focused task at a time. If work is interrupted, leave the actual state and the next action.
3. Complete all necessary callers, tests, fixtures, config, and documentation for that task. Ask about consequential ambiguities when they become relevant; log them in **Decisions to resolve**. Continue independent work when possible.
4. Before handoff, update the task status and evidence, the current stage/active task/next task, and the last-updated date. Append one task-log entry with changes, actual checks/results, and remaining blockers or limits. Do this after every task, including fixes and documentation work; do not wait until a phase ends.
5. Mark a task `DONE` only when its completion criteria pass. If a check was not run, name it; do not imply success. Missing required verification leaves the task unfinished. Preserve prior log entries and stable task IDs.
6. For work outside an existing task, add a focused task to the appropriate phase before implementing it. For scope changes, record the decision and affected tasks. Do not silently expand the MVP or rewrite history.

Statuses: `TODO` = not started; `IN_PROGRESS` = started but unfinished; `BLOCKED` = cannot continue without a named decision/dependency; `DONE` = completion criteria met with evidence; `DEFERRED` = explicitly postponed, with reason. Only the evidence column and log establish what was actually checked.

## Product contract

**User:** a small manufacturing business owner or finance manager with existing financial records. An accountant can review the exported report; a separate collaboration portal is outside the MVP.

**End-to-end workflow:** enter/upload statements -> review figures -> calculate indicators -> identify evidence gaps -> explain next steps -> export a preparation report. Corrections must refresh the affected results and supersede outdated reports.

**Input scope:** one active business at a time, one to three completed annual periods, INR, standalone statements, and English digital PDFs. Balance sheets and P&L statements are primary; cash-flow statements and borrowing notes are optional. Manual entry remains available throughout. One year gives a snapshot; trends require comparable periods.

**Each finding must show:** the result or reason it cannot be calculated, its period/unit, reviewed source values or labelled manual origin, formula/rule version, evidence status, and a specific next step. Prioritize resolving conflicts, then missing values that unlock analyses, then investigating supported changes. No unexplained aggregate financial-health score.

**Out of scope:** approval/eligibility predictions, credit/default scores, lender matching, bank/GST/bureau integrations, statement-authenticity checks, OCR, multiple currencies, consolidated groups, forecasts/scenarios, cloud deployment, and CI/CD. Docker packaging, charts, and extra export formats are optional future work.

### Financial rules to freeze in P1-01

These definitions come from the proposal. They are the implementation starting point, not a claim of finance-reviewer approval. Resolve the remaining precision, sign, and input-mapping decisions before writing the calculation engine.

| Indicator | Calculation | Required rule |
| --- | --- | --- |
| Revenue growth | `100 * (current revenue - prior revenue) / prior revenue` | Two comparable periods; prior revenue must be positive. A missing prior period is `Not assessed`. |
| Net profit margin | `100 * profit after tax / revenue from operations` | Consistent reporting basis; zero revenue is `Not meaningful`. |
| Working capital | `current assets - current liabilities` | Display an INR amount, including a negative amount when supported. |
| Current ratio | `current assets / current liabilities` | Zero denominator is `Not meaningful`; no universal acceptable threshold. |
| Debt-to-equity | `defined interest-bearing borrowings / total equity` | Count current maturities once; exclude and disclose leases. Non-positive equity is `Not meaningful`. |
| Interest coverage | `reviewed EBIT / interest expense` | EBIT is not EBITDA. Missing interest is `Not assessed`; zero interest is `Not meaningful`, never infinity or a favourable score. |

- Python `Decimal` owns financial arithmetic. Keep entered decimal text intact at the API boundary; do not calculate money/ratios using JavaScript floating-point arithmetic or an LLM. Freeze serialization and display rounding in P1-01.
- Preserve a missing value separately from numeric zero. Preserve meaningful negative values; agree rules for unexpected signs rather than applying `abs()` or coercing them to zero.
- Preserve raw value, unit multiplier, normalized INR amount, period, standalone reporting basis, source/origin, review status, and revision. Manual input must remain labelled as user-provided.
- Check period/unit consistency and the balance-sheet equation using an explicit rounding tolerance. Add total assets and total liabilities inputs when needed for that check; do not silently equate borrowings with all liabilities.
- Optional operating cash flow may be shown when available; missing cash-flow statements mean cash generation is not assessed. They do not block unrelated indicators.

### Evidence states

| State | Meaning | Required behaviour |
| --- | --- | --- |
| Supported | All required inputs are reviewed and comparable | Calculate; expose inputs and source/manual origin. |
| Needs review | A required input is unconfirmed, conflicting, or comparability is unresolved | Explain the disputed input; withhold dependent conclusions until resolved. |
| Not assessed | A required input or comparable period is absent | Name the missing item and affected analysis; keep unrelated results available. |
| Not meaningful | Reviewed inputs make the formula/interpretation unsuitable | Explain the reason; do not show an invented ratio, infinity, or favourable badge. |

P1-01 must settle state precedence for mixed problems. Finding text may describe observed changes and suggest investigation; it cannot establish unsupported causes or promise a lending outcome.

## Technical boundaries

- Keep the existing frontend at the repository root. Prefer default shadcn components, existing theme tokens, Hugeicons, and local component state. Add libraries only for a demonstrated need.
- Add a `backend/` directory when P1-02 begins. Use one FastAPI/Pydantic application, separate Python calculation functions, and Pytest. Introduce modules as their responsibilities appear; do not create empty architecture layers.
- Phase 1 is a local fictional-data prototype. Use request-scoped calculation data with no claim of saved accounts/workspaces; clearly show any unsaved state. Persistence and authentication arrive together in Phase 2 before private-data use.
- Phase 2 adds PostgreSQL/SQLAlchemy/migrations. Add pgvector when retrieval needs it. Version reviewed values and analysis outputs; enforce ownership in backend queries, file access, and retrieval.
- Phase 3 adds pdfplumber for supported digital layouts, protected file storage, page-linked extraction, and one bounded job at a time.
- Phase 4 adds local Sentence Transformers embeddings and Ollama inference. Numerical answers use reviewed values and Python outputs; document answers use authorised passages. The LLM receives no arbitrary execution or mutation privileges.
- Phase 5 completes reports, deletion, audit history, reproducible evaluation, and delivery. No paid API/hosting requirement.
- Freeze dependency/model versions when introduced and record actual commands. Do not invent backend/test commands before the corresponding setup exists.

## Phase 0: foundation

**Exit gate:** repository guidance is available, the live spec exists, and the existing frontend builds with lint errors resolved. Document any accepted warnings.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P0-01 | DONE | Initialize React/TypeScript/Vite, Tailwind, shadcn preset, icons, and theme. This task covers scaffold presence; build readiness is P0-03. | Configuration and source files inspected on 2026-11-07. |
| P0-02 | DONE | Add repository-wide Ponytail and CredLens instructions, thin host adapters, and license attribution. | Files inspected on 2026-11-07; live loading in each host has not been tested. |
| P0-03 | TODO | Fix the TypeScript configuration compatibility failure without changing stack/preset; preserve `@/` resolution. Run lint/build, and confirm the app and an aliased import compile. | Current blocker: `baseUrl` in `tsconfig.app.json`; inspect related configs first. Lint currently has one shadcn Fast Refresh warning. |
| P0-04 | DONE | Establish this spec, stable task IDs, baseline checks, and mandatory agent update instructions. | `docs/PROJECT_SPEC.md` plus `AGENTS.md`; documentation checks recorded in the task log. |

## Phase 1: manual-entry financial workflow

**Depends on:** Phase 0. **User flow:** open the local app -> enter company/period/unit and financial figures or load a labelled fictional example -> review/confirm -> analyse -> inspect results -> edit and re-analyse.

**Exit gate:** one complete fictional company works end to end; all six indicators and missing/invalid-input states are reproducible without a database, PDF extraction, or AI. Confirm this phase's input rules and flow with the user in P1-01 before implementation.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P1-01 | TODO | Freeze required inputs, period/unit handling, formulas, sign rules, precision/rounding, balance tolerance, review action, and evidence-state precedence. Define one balanced fictional company with two comparable years and independently checked expected results. | Record user decisions here; store the reusable fixture when the backend is created. Finance-reviewer validation remains separately recorded. |
| P1-02 | TODO | Initialize the minimal Python backend and test setup; define validated request/result schemas, decimal serialization, limits, structured errors, and the calculation API contract. | Reject malformed/non-finite amounts, unsupported units/basis, and invalid period counts; missing financial fields must remain representable. Add a meaningful boundary-validation test. |
| P1-03 | TODO | Implement the six deterministic indicators and minimal input/evidence checks against the agreed fixture, then expose them through the calculation endpoint. Return result/state, input references, formula version, and blocked reason. | At least 30 meaningful assertions spanning formulas, units, missing/unreviewed values, signs, zero denominators, equity, and period comparability; all pass. |
| P1-04 | TODO | Replace `Hello World` with accessible manual-entry and review components using the configured shadcn preset. Support one to three periods, optional/missing values, explicit confirmation, and clearly labelled fictional-example loading. | Keyboard/label checks; blanks stay missing; values survive validation errors; unsaved state is clear. No custom design system or extra dashboard sections. |
| P1-05 | TODO | Connect entry/review to Python analysis and display all six results with evidence text, units/periods, inputs, and targeted next steps. | Loading/error/retry states work; server errors preserve entered data; editing figures invalidates stale displayed results until re-analysis. No frontend duplicate formula engine. |
| P1-06 | TODO | Verify the complete manual-entry case and its controlled missing-interest variant. Record the walkthrough and automated checks with FR04-08 / NFR01/04/05 references. | Expected results match; removing interest blocks only coverage; restoring it changes coverage; one-year growth is not assessed; zero denominators and non-positive equity are explained. |

## Phase 2: persistence, security, and evidence dependencies

**Depends on:** Phase 1. **Exit gate:** reviewed data survives restart, workspaces are protected, revisions are traceable, and missing/conflicting data blocks only dependent analyses.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P2-01 | TODO | Set up PostgreSQL, SQLAlchemy, and migrations; persist businesses, periods, values/origins/review states/revisions, versioned analysis runs, and findings. | Migration and persistence tests pass; fixture can be loaded reproducibly. Add document/chat/report tables in the phases that use them. |
| P2-02 | TODO | Implement the agreed local-account/session flow, password hashing, and ownership checks; connect the UI to protected workspaces. | Authentication failures are handled; every record path checks ownership. No private-data pilot before protection is verified. |
| P2-03 | TODO | Complete the dependency map, conflicts/comparability checks, and ordered gap/action list using persisted reviewed inputs. | Fixed cases for unreviewed/conflicting values, wrong units, and mismatched periods block the affected findings without suppressing unrelated results. |
| P2-04 | TODO | Persist corrections/reviewer/origin/revisions; invalidate dependent outputs and retain the history needed to mark later reports superseded. | Correcting a figure creates a traceable revision and refreshes affected results without falsely presenting older outputs as current. |
| P2-05 | TODO | Exercise access isolation across business/record endpoints and test persistence/revision/dependency behaviour. Start the access-test matrix and extend it with files, chat, retrieval, and reports in later phases. | All available negative cases pass; final target is at least 20 across the completed system. Trace FR01/04-06/10 and NFR02/03. |

## Phase 3: digital PDF upload and source review

**Depends on:** Phase 2. **Exit gate:** one supported company case completes upload -> extraction -> page-linked correction/review -> financial analysis.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P3-01 | TODO | Add protected PDF storage, type/content/size/page validation, and bounded processing with progress/failure/retry states. | Enforce 20 MB/50-page limits and one active job; reject unsupported/scanned-only inputs clearly. Interrupted jobs never appear complete; failed uploads leave no accessible orphan data. |
| P3-02 | TODO | Extract candidate values/text/tables with pdfplumber for a deliberately limited set of digital layouts. Retain page, period, units, raw text/value, and source context. Reserve a held-out business/layout before tuning extraction or retrieval. | Candidates remain unreviewed; ambiguous/missing data is flagged. Measure raw extraction accuracy before manual correction; retain manual fallback. |
| P3-03 | TODO | Add a page-linked source-review UI with corrections and explicit confirmation, reusing the Phase 1 form and Phase 2 revisions. | A user can inspect the actual source page, correct a value, and distinguish document-supported from manual-origin figures. |
| P3-04 | TODO | Run the full upload/review/analysis case plus rejected-file, interrupted-job, and cross-business file-access cases. | Record correction effort and extraction errors separately from final calculation accuracy; trace FR02-06 and NFR05-08. |

## Phase 4: local retrieval and evidence-grounded Q&A

**Depends on:** Phase 3 for product integration. **Early feasibility exception:** P4-01 may run after Phase 1, before extensive PDF work, to test the proposal's local-runtime assumption; it does not add chat to the app or delay core calculations.

**Exit gate:** focused questions receive supported numerical/document answers with checked citations or a specific missing-evidence explanation. The deterministic workflow remains usable if the model fails.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P4-01 | TODO | Trial a small local instruction model with Ollama and an embedding candidate. Record machine/runtime, license, versions, model/context size, latency, memory, and offline settings. | Choose the smallest workable configuration from actual measurements; record a template/calculation fallback if hardware is insufficient. No unmeasured hardware claims. |
| P4-02 | TODO | Add period/page-aware chunks, local embeddings, pgvector retrieval, and ownership filtering before retrieval. | Retrieved passages belong to the authorised business/document and fit the chosen embedding model's documented input limit; isolation tests pass. |
| P4-03 | TODO | Add answer assembly and a focused Q&A UI: numerical questions use reviewed values and Python outputs; document questions use authorised passages with page/section citations. | Evidence citations resolve and support the text; missing inputs produce useful requests; unavailable models fall back to explicit template text. |
| P4-04 | TODO | Verify unsupported causes/lending claims, prompt injection, missing/conflicting evidence, numerical correctness, and cross-business chat/retrieval access. | No arbitrary LLM execution/mutations; unsupported claims are withheld; record useful answer coverage as well as refusal correctness. Trace FR07-08 and NFR01-04. |

## Phase 5: reporting, evaluation, and delivery

**Depends on:** Phases 1-4. **Exit gate:** the complete demo is reproducible, reports are traceable/current, active data can be deleted, and measured evaluation results and limitations are documented.

| ID | Status | Task and completion criteria | Evidence / remaining work |
| --- | --- | --- | --- |
| P5-01 | TODO | Generate a printable preparation report with inputs/periods, six results, evidence states/sources, missing evidence, ordered actions, rule/data versions, and limitations. | Start with the smallest printable implementation; no extra export library without a need. Corrections supersede older reports; users can identify which version is current. |
| P5-02 | TODO | Complete active-document/derived-data deletion and minimal audit events (actor/action/time, no full financial payloads). Extend ownership tests to reports and deletion. | Verify files, chunks/embeddings, values, runs/findings, chat, and reports are removed or handled consistently; disclose backup limits. At least 20 negative access cases pass across the final system. |
| P5-03 | TODO | Finish the evaluation data pack: four fictional businesses (up to three years), controlled evidence-error variants, selected standalone pages from three HUL reporting years, and a held-out business/layout. | One member annotates and another checks. Freeze 60 questions and expected answers/refusals before evaluation: 12 each for numerical, document, missing-input, inconsistent-input/period, and unsupported causal/lending questions. |
| P5-04 | TODO | Compare A: basic RAG, B: RAG plus calculations, C: full CredLens with dependencies/evidence states. Run end-to-end, formula, access, offline, and deletion checks; conduct available usability/finance review. | Equal documents/reviewed values, model, questions, and retrieval settings across variants. Report extraction separately; record correctness, citation support, blocked analyses, false refusals, useful coverage, correction effort, task completion/time, latency/memory, sample sizes, reviewer disagreements, and failures. |
| P5-05 | TODO | Prepare reproducible local setup/demo instructions, known limitations, dependency/model versions, contribution log, and final project README. | A teammate can reproduce the live demo from a clean clone using documented prerequisites; optional cached output is clearly labelled. Replace temporary README notes with product documentation. |

### Final demonstration checklist

- Upload a fictional company's digital statements and correct one extracted value at its source.
- Show a margin change with reviewed inputs, calculation, source, period, and unit.
- Leave interest missing: coverage says `Not assessed` and requests interest expense while unrelated results remain available.
- Supply/confirm interest, re-run analysis, and produce a refreshed report; the old report is marked superseded.
- Demonstrate denied cross-business access and an unsupported loan-approval question handled without invented claims.
- Demonstrate active-data deletion and local processing without network-dependent model calls after setup.

## Decisions to resolve

No product implementation is blocked by an unanswered question during this planning task. Resolve each item before its consuming task; do not treat pending later-phase choices as permission to stop independent earlier work.

| ID | State | Decision needed | Resolve before |
| --- | --- | --- | --- |
| D-01 | OPEN | Confirm the first entry/review flow, financial field mapping (especially borrowings, EBIT, and equity), allowed units/periods, sign rules, decimal/display precision, balance tolerance, and mixed evidence-state precedence. | P1-01 completion |
| D-02 | OPEN | Arrange finance-reviewer input on definitions and sample findings. If unavailable initially, label definitions provisional and record the validation gap; do not invent reviewer approval. | Review sample before presenting financial interpretation as validated; revisit at P5-04 |
| D-03 | OPEN | Choose team-compatible Python/dependency commands and versions, then database provisioning and local-account/session details when needed. The stack itself is already agreed. | Python details at P1-02; database/auth details at P2-01/02 |
| D-04 | OPEN | Choose licensed local models/context settings and retrieval limits based on measured available hardware. MiniLM remains a candidate. | P4-01 completion |
| D-05 | OPEN | Confirm permission/source/licensing for evaluation excerpts and availability of 2-3 target users plus a finance reviewer. If only faculty/student proxies participate, label them accurately. | Data collection and P5-03/04 |

### Decision history

| Date | Decision | Consequence |
| --- | --- | --- |
| 2026-11-07 | Use one repository spec/progress tracker and require an update after every task. | Task IDs, current stage, decisions, evidence, and handoffs live here; `AGENTS.md` points to this file. |
| 2026-11-07 | Repair baseline build before product work, then follow the proposal's manual-first five phases. | P0-03 is next; PDF/AI features follow a working deterministic financial workflow. |

## Task log

Append a row after each task. Include task ID (or add one), actual completion date, concrete change, exact checks/outcomes, and next action or known limitation. A commit/PR link is optional when available; never invent one. Earlier setup dates are not reconstructed: the baseline records only what was inspected on 2026-11-07.

| Date | Task | Changes and verification | Next action / limits |
| --- | --- | --- | --- |
| 2026-11-07 | P0-04 | Added this phased spec/tracker and required read/update rules in `AGENTS.md`. Reviewed repository and full milestone proposal. Baseline: `bun run lint` completes with one shadcn Fast Refresh warning; `bun run build` fails with TS5102 on `baseUrl`. Documentation links/task IDs and `git diff --check` verified. | P0-03: repair frontend build. No application implementation or runtime walkthrough performed. |
