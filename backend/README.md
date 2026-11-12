# CredLens backend

The backend provides FastAPI validation and deterministic financial analysis. P2-01 adds PostgreSQL persistence and Alembic migrations for internal backend callers. Authentication and public save/load routes remain P2-02; use fictional data only.

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
- Invalid requests return HTTP 422 with `detail`, a list of `{loc, type, msg}` errors. `loc` identifies the field path. Submitted values and validator context are omitted from errors. No financial payloads are logged by application code.

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

The allowed financial keys and financial rules are in the [confirmed contract](../docs/FINANCIAL_CONTRACT.md). `values` is a sparse dictionary: omitted fields are missing. Each supplied figure has `raw` (string or null), `reviewed` (default false), `revision` (positive integer, default 1), and `origin` (only `manual`). Empty/whitespace raw strings are missing, and cannot be marked reviewed. Missing and unreviewed inputs remain valid request data; the engine explains which findings they block.

Raw strings are limited to 64 characters including surrounding whitespace, and their trimmed form must have an optional sign, 1-15 ASCII integer digits, and optionally 1-2 decimal digits. Examples: `"0"`, `"-12.50"`, `" +0.10 "`. Commas, exponent notation, currency symbols, numeric JSON values, NaN, and infinity are rejected. Negative plain-decimal inputs are accepted for evidence review by P1-03, not silently changed or treated as automatically supported.

The [fictional request fixture](tests/fixtures/aster_components.json) matches the contract's reference company and starts unreviewed. Confirm its figures before expecting supported results. When changing this example, update the contract, fixture, and [calculation tests](tests/test_analysis.py) together.

## Calculation API

`POST /api/analysis` uses `AnalysisRequest` and `AnalysisResponse` in [app/schemas.py](app/schemas.py), backed by [app/analysis.py](app/analysis.py).

- `AnalysisResponse`: `rule_version` (`financial-rules-v1`), limitations (provisional rules, cash generation not assessed, lease exclusion), and 1-3 period results.
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

Start FastAPI and Vite using the existing commands, then check `GET /api/health/database` through Vite's `/api` proxy. Success is `{"status":"ok","database":"connected"}`; missing/invalid credentials or connection failures return sanitized HTTP 503. `/api/health` remains a database-independent liveness check. Financial analysis remains request-scoped and unsaved; connecting the database does not implement business persistence or authentication.

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


## Persistence and migrations (P2-01)

See [the persistence contract](../docs/PERSISTENCE_PLAN.md). `app/models.py` defines five tables: owners, businesses, periods, figures, and analysis_runs. Financial amounts use PostgreSQL NUMERIC; raw strings, missing values, units/multipliers, review state, and revisions are preserved. Analysis runs store the input revision, rule version, input snapshot, full findings/evidence, and timestamp in JSONB with decimal strings. P2-04 adds corrections and supersession.

Run migrations from `backend/` using the **direct** URL in `DATABASE_URL_UNPOOLED`:

```bash
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m alembic current
.venv/bin/python -m alembic check
```

Environment variables take precedence over the root env file. To test a migration, obtain a disposable branch's direct URL securely and set both `DATABASE_URL_UNPOOLED` and `PERSISTENCE_TEST_URL` to that branch. Never print or commit these URLs. Run:

```bash
.venv/bin/python -m alembic upgrade head
.venv/bin/python -m pytest tests/test_persistence.py -q
```

The persistence tests commit fictional records to verify reload across connections, then remove only their own generated owner/business records. They skip unless `PERSISTENCE_TEST_URL` is set, and expect the database to be migrated already. Test `alembic downgrade base` then `upgrade head` only on a disposable branch: downgrade destroys these tables and their data. Default application startup never migrates automatically.

To load the unreviewed fictional Aster Components fixture into the database selected by `DATABASE_URL`:

```bash
.venv/bin/python -m app.seed
```

This is idempotent for the fixed demonstration owner and company name. It creates an internal owner ID, not a login account; do not associate that owner with real users. It does not confirm figures or replace existing data. This seed was exercised only on the disposable branch; production received empty tables.

`app/persistence.py` exposes `save_business`, `load_business`, `save_analysis`, and `load_analysis` for backend callers. Use `with get_engine().begin() as connection:` for writes so a complete business or analysis is committed atomically. Reads and analysis operations require an owner ID and enforce it in database queries. P2-02 must derive that ID from a verified server session. No public saved-record routes or browser saving exist yet; the current UI remains explicitly unsaved. FastAPI-managed accounts were selected by the user for P2-02.

Dependency verification (2026-11-12): [Alembic 1.20.1](https://pypi.org/pypi/alembic/json), Python >=3.10 and SQLAlchemy >=2.0, is compatible with installed SQLAlchemy 2.1.8/Python 3.14.8. Resolved transitive Mako 1.4.3 and MarkupSafe 3.0.4 are pinned alongside it. Migration setup follows the [official Alembic tutorial](https://alembic.sqlalchemy.org/en/latest/tutorial.html). Existing dependencies were not upgraded.
