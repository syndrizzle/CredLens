# CredLens backend

The backend provides FastAPI validation, deterministic financial analysis, PostgreSQL persistence/migrations (P2-01), and FastAPI-managed local accounts, server sessions, and owner-scoped workspace endpoints (P2-02). Use fictional data until full Phase 2 verification is complete.

## Setup and run

Use Python 3.14 (tested with 3.14.8). From the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On Windows, use `py -3.14` (or `py -3.12`) and `.venv\Scripts\python.exe` instead. Python must have pip/venv support; Linux distributions may package these separately. The financial-year check uses `Asia/Kolkata` timezone data; `tzdata` is pinned in `requirements.txt` for platforms such as Windows that lack a system IANA zoneinfo database. No global package installation is needed.

OpenAPI documentation is at `http://127.0.0.1:8000/docs`. The pinned `requirements.txt` includes runtime and test dependencies for local development. Do not commit `.venv` or caches. The calculation routes still work without a database; the optional database health route requires `DATABASE_URL`. The frontend uses a Vite development proxy to this local backend; see the root [workflow instructions](../README.md#run-the-phase-1-workflow-locally).

Run tests from `backend/`:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m pip check
```

## Current API

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/validate` validates a request and returns its canonical form, filling defaults while preserving raw amount text. This does not calculate ratios, normalize amounts, confirm review, or check balance-sheet consistency.
- `POST /api/analysis` accepts the same request, normalizes amounts to INR, checks evidence and balance-sheet consistency, and returns all six indicators per year. It does not save or confirm submitted figures.
- `POST /api/auth/register` creates an owner and account (`email`, `password` of 12–128 characters), hashes the password with standard-library `hashlib.scrypt` (`n=16384, r=8, p=1, dklen=32`), creates a 7-day server session, sets the `HttpOnly` `credlens_session` cookie, and returns `{"owner_id","email"}` (HTTP 201, or 409 if the email is already registered).
- `POST /api/auth/login` verifies credentials in constant time, sets the session cookie, and returns `{"owner_id","email"}` (HTTP 200, or uniform 401 `{"detail":"Invalid email or password"}`).
- `POST /api/auth/logout` deletes the server session and clears the session cookie.
- `GET /api/auth/session` returns `{"owner_id","email"}` for a valid active session or HTTP 401.
- `GET /api/businesses` lists the authenticated owner's saved businesses (`[{"id","business_name","input_revision"}]`).
- `POST /api/businesses` atomically saves a validated `AnalysisRequest` under the session owner, records `input_revision = 1` in `revisions`, and returns the `WorkspaceResponse` (`business_id`, `input_revision`, `request`, `latest_run_id`, `latest_analysis`, `runs`).
- `GET /api/businesses/{business_id}` loads an owned workspace, its current analysis run (`latest_run_id`/`latest_analysis` when `run.input_revision == business.input_revision`, otherwise `null`), and its full `runs` summary list (`run_id`, `input_revision`, `rule_version`, `created_at`, `superseded`), or returns HTTP 404 (`{"detail":"Business not found"}`) for both unknown and other-owner IDs.
- `PUT /api/businesses/{business_id}` atomically updates an owned business in place when `expected_revision` matches the stored `input_revision`, increments `input_revision`, computes per-figure `revision` and `reviewed_by`, records an immutable `revisions` snapshot, marks earlier `analysis_runs` as `superseded` (`latest_run_id: null`, `latest_analysis: null`), and returns the updated `WorkspaceResponse` (or HTTP 409 on stale `expected_revision`, HTTP 404 for unknown/other-owner IDs).
- `POST /api/businesses/{business_id}/analysis` runs deterministic analysis on the saved business under a row lock (`SELECT ... FOR UPDATE`), persists the versioned `analysis_runs` snapshot for the current `input_revision`, and returns the updated `WorkspaceResponse` (or HTTP 404).
- `GET /api/analysis-runs/{run_id}` loads a saved `AnalysisRunResponse` (`run_id`, `business_id`, `input_revision`, `superseded`, `created_at` alongside the full `AnalysisResponse`) if owned by the session user, or returns HTTP 404 (`{"detail":"Analysis not found"}`).
- `GET /api/businesses/{business_id}/documents` lists uploaded `DocumentSummary` records for an owned workspace after reconciling any interrupted `processing` job to `failed` (`interrupted_job`), or returns HTTP 404.
- `POST /api/businesses/{business_id}/documents` authenticates and caps the raw request at 20 MB + 64 KiB multipart overhead before FastAPI parses it. Extension/MIME/header/empty/file-size errors reject without a document row/file. After those checks, it commits `processing` metadata before writing and inspecting the PDF. HTTP 201 returns the durable `DocumentSummary`, which can be `ready` or `failed`; encrypted, malformed, scanned-only, >50-page, and resource-budget failures retain an owner-protected failed record/file for removal or retry. Storage is local under `backend/.storage/documents/<owner_id>/<business_id>/<document_id>.pdf`, configurable via `DOCUMENT_STORAGE_DIR`.
- `POST /api/businesses/{business_id}/documents/{document_id}/retry` re-runs bounded PDF processing and candidate extraction on a `failed` or interrupted document under the single-active-job gate and returns the updated `DocumentSummary` (or HTTP 404/409).
- `GET /api/businesses/{business_id}/documents/{document_id}/extraction` returns the owner-protected `DocumentExtractionResponse` (`DocumentSummary` fields plus `extraction_status`, `extraction_message`, and the validated `DocumentExtractionSnapshot` when `status == "ready"` and extracted). A stored v1 snapshot returns `refresh_required` and `extraction: null`. Use the owner-protected extract action to refresh it to `document-extraction-v2` before candidate review. Legacy pre-P3-02 ready documents return `extraction_status: "not_extracted"` and `extraction: null`; processing, failed, interrupted, and pending-removal documents return `extraction: null` with their respective `extraction_status` (or HTTP 404 for unknown/other-owner/cross-business IDs).
- `POST /api/businesses/{business_id}/documents/{document_id}/extract` (and `/extraction`) runs bounded candidate extraction on an existing `ready` document under the per-owner single-active-job advisory lock without re-upload or relaxing failed-document `retry` semantics, and returns the updated `DocumentExtractionResponse` (or HTTP 404/409).
- `GET /api/businesses/{business_id}/documents/{document_id}/file` streams the stored PDF (`application/pdf`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`) for the authenticated owner's workspace, or returns HTTP 404.
- `DELETE /api/businesses/{business_id}/documents/{document_id}` commits a `failed` / `deletion_pending` removal intent before unlinking the PDF/temp file, then deletes the row (and any stored extraction snapshot). An unsuccessful intent commit preserves the PDF. An unlink or final-commit failure leaves a visible pending-removal record; press Remove again to finish (HTTP 503 on service failure, 404 on unknown IDs, 409 while another job is active). Pending removals cannot be viewed or retried as processing jobs.
- `POST /api/businesses/{business_id}/retrieval` embeds `query` locally on CPU (`sentence-transformers/all-MiniLM-L6-v2`, `HF_HUB_OFFLINE=1`) and searches `document_chunks` using pgvector cosine distance after enforcing `owner_id`, `business_id`, and `documents.status = 'ready'` in SQL `WHERE` (returns HTTP 401/404/422/503).
- `POST /api/businesses/{business_id}/qa` loads the owned workspace, current-revision deterministic `analyse()` outputs, and authorised passages inside a short DB transaction (closed before inference), then calls local loopback Ollama (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434`, default `qwen3:4b-instruct`, rejecting remote hosts and `:cloud`/`-cloud` tags) or falls back explicitly to a deterministic citation-grounded template summary (`mode: "fallback"`). Strictly read-only with server-verified `[F#]`/`[D#]` citations and lending/scoring/prompt-injection guardrails.
  Questions about saved calculations alone use the current results and evidence states. Document questions can quote authorised excerpts. Review and confirm PDF candidates in the workspace form before they can support a calculation.
- Invalid requests return HTTP 422 with `detail`, a list of `{loc, type, msg}` errors (or `{code, message}` for immediate document request rejections). `loc` identifies the field path. Submitted values (including passwords, emails, and financial figures) and validator context are omitted from errors. No financial payloads or credentials are logged by application code.

PDF inspection and candidate extraction (`app/pdf_extraction.py`) run in a single pass inside a separate local Python process (`app/pdf_worker.py`) with a 15-second wall deadline, 10-second CPU budget (POSIX hard stop at 11 seconds), and 512 MiB memory ceiling. Page objects are constructed individually and iteration stops before page 51; decoded page content streams are capped at 8 MiB each / 32 MiB total, extracted non-whitespace text at 250,000 characters, retained page text (including whitespace) at 50,000 characters per page / 350,000 total, tables at 10 per page, table rows at 250 per page / 2,000 total, table columns at 16, table cells at 1,000 characters each / 10,000 total cells, extracted candidates at 500, and serialized child stdout at 2 MiB. Resource-budget failures suggest a smaller file or manual entry. Limits install before importing the parser and fail closed if unavailable. Linux uses `resource`; Windows uses a [Job Object](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_extended_limit_information) with process memory/time limits.

Document writes accept an SQLAlchemy `Engine` and own their short database transactions. A per-owner transaction-scoped advisory lock on a dedicated connection serializes upload/retry/extract/removal across backend processes (also through a transaction pooler); the partial unique index remains a second guard. Listing/workspace reads only reconcile `processing` rows when that lock is free. A real service crash or failed final-status commit therefore leaves a durable row and any written PDF, recoverable through refresh and retry. A crash before the file is complete may require Remove/re-upload; `.tmp` files are removed with the document. Validated `extraction` snapshots publish atomically with `status = "ready"` and never write to `figures`, confirm values, advance `businesses.input_revision`, or invalidate `analysis_runs`. Failed PDF validation never enables viewing or financial analysis, and has no effect on manual figures. The UI's Refresh document status preserves the current financial draft.

These are local-host resource bounds, not a parser security sandbox. The parser child receives no database credentials through its environment. Keep the storage directory on the same private backend host; operating-system access control/Windows ACLs remain necessary. Durable state refers to completed database transactions and ordinary process interruption, not power-loss guarantees for the local filesystem. No cleanup of database backups is claimed.

Example request:

```json
{
  "business_name": "Example business",
  "currency": "INR",
  "basis": "standalone",
  "periods": [{
    "year_start": 2023,
    "unit": "rupees",
    "comparable_to_prior": false,
    "values": {
      "revenue": {"raw": "10000000.00", "reviewed": true},
      "interest_expense": {"raw": null}
    }
  }]
}
```

`year_start: 2023` means 1 April 2023 through 31 March 2024. Years must be complete as of the current date in India. Periods can arrive in any order; duplicate years are rejected. The engine finds the immediately preceding year rather than assuming array order, and returns periods in ascending order.

Requests accept 1-3 periods, a business name of 1-120 non-whitespace characters, only INR/standalone basis, and units `rupees`, `thousands`, `lakhs`, or `crores`. Unknown properties and unknown financial field keys are rejected. Booleans/integers are strict: strings such as `"true"` and numeric amounts are not coerced.

The allowed financial keys and financial rules are in the [confirmed contract](../docs/FINANCIAL_CONTRACT.md). `values` is a sparse dictionary: omitted fields are missing. Each supplied figure has `raw` (string or null), `reviewed` (default false), `revision` (positive integer, default 1), `origin` (`manual` or `document`, default `manual`), and optional `source` (`FigureSource`, required when `origin` is `document`, forbidden when `origin` is `manual`). Empty/whitespace raw strings are missing, and cannot be marked reviewed or `document`-origin. On protected workspace saves (`POST /api/businesses`, `PUT /api/businesses/{id}`), every `document` figure is verified against an owned `ready` `document-extraction-v2` candidate (or an unchanged previously detached reference after PDF removal); mismatches return HTTP `422`. Missing and unreviewed inputs remain valid request data; the engine explains which findings they block.

Raw strings are limited to 64 characters including surrounding whitespace, and their trimmed form must have an optional sign, 1-15 ASCII integer digits, and optionally 1-2 decimal digits. Examples: `"0"`, `"-12.50"`, `" +0.10 "`. Commas, exponent notation, currency symbols, numeric JSON values, NaN, and infinity are rejected. Negative plain-decimal inputs are accepted for evidence review by P1-03, not silently changed or treated as automatically supported.

The [fictional request fixture](tests/fixtures/aster_components.json) matches the contract's reference company and starts unreviewed. Confirm its figures before expecting supported results. When changing this example, update the contract, fixture, and [calculation tests](tests/test_analysis.py) together.

## Calculation API

`POST /api/analysis` uses `AnalysisRequest` and `AnalysisResponse` in [app/schemas.py](app/schemas.py), backed by [app/analysis.py](app/analysis.py).

- `AnalysisResponse`: `rule_version` (`financial-rules-v1`), limitations (provisional rules, cash generation not assessed, lease exclusion), and 1-3 period results.
- New analyses also contain `action_version: "preparation-actions-v1"` and ordered `actions`: category (`review`, `missing`, `interpretation`, `investigate`), reason code, message, input references (`year_start`, `field`), and affected finding references (`year_start`, `indicator`, including `balance_check`). Shared issues are grouped across findings/years. The order is workflow priority, never a credit-risk ranking; ties preserve chronological finding order. Formula/evidence rules are unchanged.
- Actions come from the existing deterministic findings and balance checks, including every reason when a finding has mixed problems. Missing interest targets coverage only; missing totals target the balance check without blocking independent ratios. A confirmed balance/component conflict targets the consistency check and three balance-sheet indicators. Mixed units are normalized before comparison; years must be consecutive and explicitly comparable for growth. Invalid unit labels and duplicate years fail validation, while incorrect source-unit labelling still requires manual review.
- Saved runs retain the action list/version in their existing JSONB snapshot. Legacy snapshots without action fields load as `action_version: null`, `actions: []`; the UI asks for a new analysis to generate them. Loading an old run does not silently recalculate or attach new findings.
- Each period result has `year_start` and exactly six distinct indicators: `revenue_growth`, `net_profit_margin`, `working_capital`, `current_ratio`, `debt_to_equity`, and `interest_coverage`.
- Each period also has `balance_check`: evidence state, signed `difference_inr` (assets minus liabilities minus equity, or null when unchecked), `tolerance_inr`, input evidence, and reasons. Missing totals alone do not block indicators; confirmed balance/component conflicts block the three balance-sheet indicators.
- Each indicator has `state`, `value`, `inputs`, `reasons`, and `next_step`. States use the four exact labels in the financial contract.
- A supported result requires a finite decimal value; other states require null value and at least one reason. A reason contains a stable `code`, plain-language `message`, and affected `fields`.
- Each input reference identifies year, field, unit, original figure/review/revision, and `normalized_inr`. Origin remains manual in Phase 1.
- JSON serializes Decimal result values and normalized amounts as ordinary decimal strings, never floating-point numbers or scientific notation. Working capital is INR, growth/margin are percentages, and other indicators are ratios. The engine uses an isolated Decimal context with precision 34 and no intermediate display rounding. The frontend results UI formats values to two decimal places.

The engine applies state precedence independently to each indicator: Needs review, Not assessed, Not meaningful, Supported. It retains all relevant reasons and only calculates supported results. Reason codes are `missing_input`, `unreviewed`, `negative_input`, `missing_prior_year`, `comparability_unconfirmed`, `invalid_denominator`, `balance_mismatch`, and `component_exceeds_total`. Next steps identify needed corrections/evidence or suggest investigation without lending thresholds or inferred causes. Arithmetic tests do not replace finance-reviewer validation.

## Dependency verification

Checked live PyPI release metadata on 2026-11-07 (and `tzdata` on 2026-11-12), then compared it with the installed versions. These are registry-resolved versions, not values selected from memory:

| Direct dependency | Latest stable / installed | Official registry source | Python requirement |
| --- | --- | --- | --- |
| FastAPI | 0.162.2 | [PyPI](https://pypi.org/pypi/fastapi/json) | >=3.10 |
| Pydantic | 2.14.3 | [PyPI](https://pypi.org/pypi/pydantic/json) | >=3.10 |
| Uvicorn | 0.54.0 | [PyPI](https://pypi.org/pypi/uvicorn/json) | >=3.10 |
| Pytest | 9.2.0 | [PyPI](https://pypi.org/pypi/pytest/json) | >=3.10 |
| HTTPX2 (TestClient) | 2.16.0 | [PyPI](https://pypi.org/pypi/httpx2/json) | >=3.11 |
| tzdata | 2026.6 | [PyPI](https://pypi.org/pypi/tzdata/json) | >=2 |
| pgvector (checked 2026-11-20) | 0.5.1 | [PyPI](https://pypi.org/pypi/pgvector/json) | >=3.10 |
| sentence-transformers (checked 2026-11-20) | 6.3.0 | [PyPI](https://pypi.org/pypi/sentence-transformers/json) | >=3.10 |
| torch CPU wheel (checked 2026-11-20) | 2.15.0+cpu | [PyTorch CPU index](https://download.pytorch.org/whl/cpu/torch/) | >=3.11 |

The releases are not yanked and their runtime constraints admit the tested Python 3.14.8 and Python 3.12.2 environments. The installed Starlette TestClient explicitly prefers HTTPX2 and deprecates HTTPX; use HTTPX2 for these tests. Transitive versions are frozen in `requirements.txt`; `pip check` validates installed dependency constraints. Check release metadata again before future additions/upgrades and test the resolved set before changing pins.

Implementation references: [Pydantic validators](https://docs.pydantic.dev/latest/concepts/validators/), [Pydantic serialization](https://docs.pydantic.dev/latest/concepts/serialization/), and [FastAPI validation errors](https://fastapi.tiangolo.com/tutorial/handling-errors/).


## Neon database connection (P2-00)

The selected Neon project is `solitary-bonus-79407058`, organization `org-aged-wildflower-20828140`, branch `production`. Only Postgres is enabled in the generated root `neon.ts`; Neon Auth, Functions, and other services are not enabled. `neon deploy` applies that service configuration; it does not deploy the React or FastAPI applications.

To connect a teammate's checkout, install the Neon CLI (tested `neon@9.4.0`, Node 26.13.1), sign in, then run from the root:

```bash
neon init -y --org-id org-aged-wildflower-20828140 --project-id solitary-bonus-79407058 --branch production --services postgres
neon deploy
```

The CLI writes connection credentials into ignored `.env.local` (or `.env` if present). `.neon` is also ignored. Use `.env.example` only as a template; never commit real URLs. The backend loads the root `.env`, if present, otherwise `.env.local`; existing process environment variables take priority. Restart the backend after pulling a different branch's variables.

`app/database.py` uses SQLAlchemy with Psycopg 3 over TLS. The application uses pooled `DATABASE_URL` with `NullPool` locally to avoid a second idle pool. Connection attempts have a 10-second timeout, prepared statement caching is disabled for pooling compatibility, and SQL parameters are hidden. Keep `DATABASE_URL_UNPOOLED` for migrations in P2-01. These are server variables, never `VITE_` variables or browser connections. See [Neon's connection guide](https://neon.com/docs/connect/choose-connection) and [SQLAlchemy's Psycopg dialect](https://docs.sqlalchemy.org/en/21/dialects/postgresql.html#module-sqlalchemy.dialects.postgresql.psycopg).

Start FastAPI and Vite using the existing commands, then check `GET /api/health/database` through Vite's `/api` proxy. Success is `{"status":"ok","database":"connected"}`; missing/invalid credentials or connection failures return sanitized HTTP 503. `/api/health` remains a database-independent liveness check.

For opt-in live verification from `backend/`:

```bash
RUN_NEON_TESTS=1 .venv/bin/python -m pytest -q
```

PowerShell: set `$env:RUN_NEON_TESTS = '1'` and use `.venv\Scripts\python.exe`. The live test writes/reads a fictional decimal in a temporary table inside one transaction, rolls it back, and checks the health API. It creates no permanent application tables. Default tests skip the live check and mock connection configuration/failures.

New dependencies were checked against the official registries on 2026-11-12 and the resolved versions were tested on Python 3.14.8 / Node 26.13.1:

| Package | Verified stable / pinned | Runtime | Registry |
| --- | --- | --- | --- |
| SQLAlchemy | 2.1.8 | Python >=3.11 | [PyPI](https://pypi.org/pypi/SQLAlchemy/json) |
| psycopg + psycopg-binary | 3.3.9 | Python >=3.10 | [PyPI](https://pypi.org/pypi/psycopg/json) |
| python-dotenv | 1.2.4 | Python >=3.10 | [PyPI](https://pypi.org/pypi/python-dotenv/json) |
| neon (global CLI) | 9.4.0 | Node >=20.19.0 | [npm](https://www.npmjs.com/package/neon) |
| @neon/config | 1.14.0 | Node >=20.19.0 | [npm](https://www.npmjs.com/package/@neon/config) |
| @neon/env | 2.1.3 | Node >=20.19.0 | [npm](https://www.npmjs.com/package/@neon/env) |

The CLI installed Neon plugins/skills at user scope for detected agents and configured their Neon MCP access. Those global installations are not repository content; backend connectivity uses ordinary environment variables and Psycopg and does not require an AI plugin. Bun remains the project package manager and `bun.lock` remains the only JavaScript lockfile.


## Persistence, migrations, authentication, revisions, and documents (P2-01 / P2-02 / P2-04 / P3-01 / P3-02)

See [the persistence, authentication, revision, and document contract](../docs/PERSISTENCE_PLAN.md). `app/models.py` defines nine tables: `owners`, `accounts`, `sessions`, `businesses`, `revisions`, `periods`, `figures`, `analysis_runs`, and `documents`. Financial amounts use PostgreSQL NUMERIC; raw strings, missing values, units/multipliers, review state, `reviewed_by`, and server-computed revisions are preserved. `revisions` stores immutable per-revision input snapshots (`business_id`, `input_revision`, `actor_id`, `inputs` JSONB, `created_at`). Analysis runs store the input revision, rule version, input snapshot, full findings/evidence, and timestamp in JSONB with decimal strings; runs whose `input_revision < business.input_revision` are retained and exposed in `WorkspaceResponse.runs` with `superseded: true` while `latest_run_id` and `latest_analysis` become `null` until re-analysis. `accounts` and `sessions` store `scrypt` password hashes and SHA-256 session token digests using Python standard-library `hashlib` and `secrets`. `documents` stores protected PDF metadata, processing state (`processing`, `ready`, `failed`), nullable `extraction` JSONB (`DocumentExtractionSnapshot`, migration `e519a47c8b14`), and a partial unique index (`documents_one_active_job_idx`) enforcing at most one active processing job per owner, while uploaded ready/failed PDF files live in ignored `backend/.storage/documents/<owner_id>/<business_id>/<document_id>.pdf`.

Run migrations from `backend/` using the **direct** URL in `DATABASE_URL_UNPOOLED`:

```bash
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m alembic current
.venv/bin/python -m alembic check
```

Environment variables take precedence over the root env file. For manual migration commands below, set `DATABASE_URL_UNPOOLED` to a disposable test database's direct URL. Set `PERSISTENCE_TEST_URL` to that same direct URL for live persistence/authentication/document tests. Never print or commit these URLs. Run:

```bash
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m pytest tests/test_persistence.py tests/test_auth.py tests/test_documents.py -q
```

The persistence, authentication, and document tests commit fictional records, temporary accounts, and temporary PDFs to verify reload, revision history, optimistic concurrency (`409`), single-active-job enforcement, interrupted-job reconciliation/retry, extraction snapshot lifecycle/legacy upgrade/non-interference, and owner isolation across connections, then remove only their own generated owner/account/session/business/document records and temporary files. Live database cases skip unless `PERSISTENCE_TEST_URL` is set, and expect the database to be migrated already. The populated-upgrade test temporarily binds Alembic to `PERSISTENCE_TEST_URL`, clears inherited engine caches, and checks that the migration engine matches the fixture before any DDL. It rejects Neon pooled URLs; use a direct disposable database URL. This test downgrades/upgrades the whole test schema, so the selected database must be disposable. `tests/test_migration_safety.py` checks mismatched/inherited/cached connection settings offline with migration calls intercepted. Default application startup never migrates automatically.

To load the unreviewed fictional Aster Components fixture into the database selected by `DATABASE_URL`:

```bash
.venv/bin/python -m app.seed
```

This is idempotent for the fixed demonstration owner and company name. It creates an internal owner ID without an `accounts` row, not a login account; do not associate that owner with real users. It does not confirm figures or replace existing data.

`app/persistence.py` exposes `save_business`, `update_business`, `load_business`, `save_analysis`, `load_analysis`, `list_businesses`, and `load_workspace` for backend callers, `app/auth.py` exposes `hash_password`, `verify_password`, `register_account`, `authenticate_account`, `resolve_session`, and `revoke_session`, and `app/documents.py` exposes `upload_and_process_document`, `retry_document_processing`, `extract_ready_document`, `get_document_extraction`, `list_documents`, `get_document_file`, `delete_document`, and `reconcile_interrupted_documents`. Document mutation helpers take an `Engine` and commit lifecycle stages themselves; read helpers take a caller-owned `Connection`. Every protected HTTP route in `app/main.py` derives `owner_id` from the verified `credlens_session` cookie inside a transaction.

Dependency verification (2026-11-12 & 2026-11-17): [Alembic 1.20.1](https://pypi.org/pypi/alembic/json) (Python >=3.10, SQLAlchemy >=2.0; transitive Mako 1.4.3 and MarkupSafe 3.0.4), [pdfplumber 0.11.10](https://pypi.org/pypi/pdfplumber/json) (Python >=3.8; transitive `pdfminer.six==20260107`, `pypdfium2==5.15.2`, `pillow==13.0.0`, `cryptography==50.0.2`, `cffi==2.1.1`, `pycparser==3.12`, `charset-normalizer==3.5.2`), and [python-multipart 0.0.34](https://pypi.org/pypi/python-multipart/json) (Python >=3.11) were verified against live PyPI release metadata (`yanked: false`) and pinned in `requirements.txt`. Migration setup follows the [official Alembic tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html).
