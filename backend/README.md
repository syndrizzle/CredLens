# CredLens backend

P1-02 provides a local FastAPI application, validated schemas, and boundary tests. The calculation engine and `/api/analysis` endpoint are P1-03; they are not implemented yet. Use fictional data only: no persistence or authentication exists in this phase.

## Setup and run

Use Python 3.14 (tested with 3.14.8). From the repository root:

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

On Windows, use `py -3.14` and `.venv\Scripts\python.exe` instead. Python must have pip/venv support; Linux distributions may package these separately. The financial-year check uses `Asia/Kolkata` timezone data; on systems without it, install the Python `tzdata` package in the environment. No global package installation is needed.

OpenAPI documentation is at `http://127.0.0.1:8000/docs`. The pinned `requirements.txt` includes runtime and test dependencies for local development. Do not commit `.venv` or caches. No environment variables, database, or frontend changes are needed for this task.

Run tests from `backend/`:

```bash
.venv/bin/python -m pytest -q
.venv/bin/python -m pip check
```

## Current API

- `GET /api/health` returns `{"status":"ok"}`.
- `POST /api/validate` validates a request and returns its canonical form, filling defaults while preserving raw amount text. This does not calculate ratios, normalize amounts, confirm review, or check balance-sheet consistency.
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

`year_start: 2023` means 1 April 2023 through 31 March 2024. Years must be complete as of the current date in India. Periods can arrive in any order; duplicate years are rejected. The engine will find the immediately preceding year rather than assuming array order.

Requests accept 1-3 periods, a business name of 1-120 non-whitespace characters, only INR/standalone basis, and units `rupees`, `thousands`, `lakhs`, or `crores`. Unknown properties and unknown financial field keys are rejected. Booleans/integers are strict: strings such as `"true"` and numeric amounts are not coerced.

The allowed financial keys and financial rules are in the [confirmed contract](../docs/FINANCIAL_CONTRACT.md). `values` is a sparse dictionary: omitted fields are missing. Each supplied figure has `raw` (string or null), `reviewed` (default false), `revision` (positive integer, default 1), and `origin` (only `manual`). Empty/whitespace raw strings are missing, and cannot be marked reviewed. Missing and unreviewed inputs remain valid request data, to be explained by the later engine.

Raw strings are limited to 64 characters including surrounding whitespace, and their trimmed form must have an optional sign, 1-15 ASCII integer digits, and optionally 1-2 decimal digits. Examples: `"0"`, `"-12.50"`, `" +0.10 "`. Commas, exponent notation, currency symbols, numeric JSON values, NaN, and infinity are rejected. Negative plain-decimal inputs are accepted for evidence review by P1-03, not silently changed or treated as automatically supported.

The [fictional request fixture](tests/fixtures/aster_components.json) matches the contract's reference company and starts unreviewed. When changing this example, update the contract and fixture together. Expected financial calculations remain in the contract until implemented as P1-03 tests.

## Calculation API contract for P1-03

The next task will add `POST /api/analysis` using `AnalysisRequest` and `AnalysisResponse` in `app/schemas.py`. There is deliberately no calculation route returning placeholder results today.

- `AnalysisResponse`: `rule_version` (`financial-rules-v1`) and 1-3 period results.
- Each period result has `year_start` and exactly six distinct indicators: `revenue_growth`, `net_profit_margin`, `working_capital`, `current_ratio`, `debt_to_equity`, and `interest_coverage`.
- Each indicator has `state`, `value`, `inputs`, `reasons`, and `next_step`. States use the four exact labels in the financial contract.
- A supported result requires a finite decimal value; other states require null value and at least one reason. A reason contains a stable `code`, plain-language `message`, and affected `fields`.
- Each input reference identifies year, field, unit, original figure/review/revision, and `normalized_inr`. Origin remains manual in Phase 1.
- JSON serializes Decimal result values and normalized amounts as ordinary decimal strings, never floating-point numbers or scientific notation. Working capital is INR, growth/margin are percentages, and other indicators are ratios. Display rounding and deterministic Decimal arithmetic belong to the engine/UI tasks, not the request validator.

The schemas establish shape and local invariants. P1-03 must enforce dependency/state precedence, normalization, formula correctness, period/result correspondence, and consistency checks; schema validation alone does not establish financial correctness.

## Dependency verification

Checked live PyPI release metadata on 2026-11-07, then compared it with the installed versions. These are registry-resolved versions, not values selected from memory:

| Direct dependency | Latest stable / installed | Official registry source | Python requirement |
| --- | --- | --- | --- |
| FastAPI | 0.162.2 | [PyPI](https://pypi.org/pypi/fastapi/json) | >=3.10 |
| Pydantic | 2.14.3 | [PyPI](https://pypi.org/pypi/pydantic/json) | >=3.10 |
| Uvicorn | 0.54.0 | [PyPI](https://pypi.org/pypi/uvicorn/json) | >=3.10 |
| Pytest | 9.2.0 | [PyPI](https://pypi.org/pypi/pytest/json) | >=3.10 |
| HTTPX2 (TestClient) | 2.16.0 | [PyPI](https://pypi.org/pypi/httpx2/json) | >=3.11 |

The releases are not yanked and their runtime constraints admit the tested Python 3.14.8. The installed Starlette TestClient explicitly prefers HTTPX2 and deprecates HTTPX; use HTTPX2 for these tests. Transitive versions are frozen in `requirements.txt`; `pip check` validates installed dependency constraints. Check release metadata again before future additions/upgrades and test the resolved set before changing pins.

Implementation references: [Pydantic validators](https://docs.pydantic.dev/latest/concepts/validators/), [Pydantic serialization](https://docs.pydantic.dev/latest/concepts/serialization/), and [FastAPI validation errors](https://fastapi.tiangolo.com/tutorial/handling-errors/).
