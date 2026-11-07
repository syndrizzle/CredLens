import json
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from app.main import app
from app.schemas import (
    AnalysisRequest,
    FinancialValue,
    IndicatorResult,
    InputEvidence,
    PeriodAnalysis,
    Reason,
)
from fastapi.testclient import TestClient
from pydantic import ValidationError


@pytest.fixture
def client():
    with TestClient(app) as client:
        yield client


@pytest.fixture
def payload():
    return {
        "business_name": "Example business",
        "periods": [{"year_start": 2023, "unit": "rupees", "values": {}}],
    }


def test_health_and_openapi(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    schema = client.get("/openapi.json").json()
    assert "/api/validate" in schema["paths"]
    assert "/api/analysis" not in schema["paths"]


@pytest.mark.parametrize(
    "raw,expected",
    [
        (None, None),
        ("", None),
        ("  ", None),
        ("0", Decimal(0)),
        ("  -12.50  ", Decimal("-12.50")),
        ("+0.10", Decimal("0.10")),
        ("999999999999999.99", Decimal("999999999999999.99")),
    ],
)
def test_raw_amount_preserves_text_and_missing_distinction(raw, expected):
    figure = FinancialValue(raw=raw)
    assert figure.raw == raw
    assert figure.amount == expected
    assert figure.model_dump(mode="json")["raw"] == raw


@pytest.mark.parametrize(
    "raw",
    [
        "NaN",
        "Infinity",
        "-Infinity",
        "1e3",
        "1,000",
        "₹10",
        "1.234",
        "1000000000000000",
        "1_000",
        ".5",
        "1.",
        "１２",
        "1\n2",
        1,
        1.5,
        True,
    ],
)
def test_rejects_malformed_amounts_without_echoing_financial_input(
    client, payload, raw
):
    payload["periods"][0]["values"]["revenue"] = {"raw": raw}
    response = client.post("/api/validate", json=payload)
    assert response.status_code == 422
    error = response.json()["detail"][0]
    assert "raw" in error["loc"]
    assert set(error) == {"loc", "type", "msg"}
    assert "input" not in error and "ctx" not in error


@pytest.mark.parametrize("raw", [None, "", "  "])
def test_missing_figures_cannot_be_reviewed(client, payload, raw):
    payload["periods"][0]["values"]["interest_expense"] = {"raw": raw, "reviewed": True}
    assert client.post("/api/validate", json=payload).status_code == 422


def test_incomplete_case_and_reviewed_zero_are_valid(client, payload):
    payload["periods"][0]["values"] = {
        "interest_expense": {"raw": "0", "reviewed": True},
        "ebit": {"raw": "-12.50", "reviewed": False},
        "revenue": {"raw": None},
    }
    response = client.post("/api/validate", json=payload)
    assert response.status_code == 200
    values = response.json()["periods"][0]["values"]
    assert values["interest_expense"]["raw"] == "0"
    assert values["revenue"]["raw"] is None
    assert "profit_after_tax" not in values
    assert values["ebit"]["raw"] == "-12.50"


@pytest.mark.parametrize(
    "change",
    [
        "empty_periods",
        "four_periods",
        "duplicate_year",
        "future_year",
        "bool_year",
        "unit",
        "currency",
        "basis",
        "field",
        "review_type",
        "revision",
        "origin",
        "unknown",
        "blank_name",
        "long_name",
    ],
)
def test_rejects_invalid_request_context(client, payload, change):
    period = payload["periods"][0]
    if change == "empty_periods":
        payload["periods"] = []
    elif change == "four_periods":
        payload["periods"] = [
            {**period, "year_start": year} for year in range(2019, 2023)
        ]
    elif change == "duplicate_year":
        payload["periods"] = [period, period]
    elif change == "future_year":
        period["year_start"] = datetime.now(ZoneInfo("Asia/Kolkata")).year
    elif change == "bool_year":
        period["year_start"] = True
    elif change == "unit":
        period["unit"] = "dollars"
    elif change in ("currency", "basis"):
        payload[change] = "unsupported"
    elif change == "field":
        period["values"]["made_up_field"] = {"raw": "10"}
    elif change == "review_type":
        period["values"]["revenue"] = {"raw": "10", "reviewed": "true"}
    elif change == "revision":
        period["values"]["revenue"] = {"raw": "10", "revision": 0}
    elif change == "origin":
        period["values"]["revenue"] = {"raw": "10", "origin": "document"}
    elif change == "unknown":
        payload["extra"] = "not allowed"
    else:
        payload["business_name"] = " " if change == "blank_name" else "x" * 121
    assert client.post("/api/validate", json=payload).status_code == 422


@pytest.mark.parametrize("unit", ["rupees", "thousands", "lakhs", "crores"])
def test_supported_units_and_three_distinct_years(client, payload, unit):
    payload["periods"] = [
        {"year_start": year, "unit": unit} for year in (2021, 2022, 2023)
    ]
    assert client.post("/api/validate", json=payload).status_code == 200


def test_malformed_json_has_structured_errors(client):
    response = client.post(
        "/api/validate",
        content='{"business_name":',
        headers={"content-type": "application/json"},
    )
    assert response.status_code == 422
    assert set(response.json()["detail"][0]) == {"loc", "type", "msg"}


def test_decimal_result_serialization_and_state_invariants():
    result = IndicatorResult(
        indicator="working_capital",
        state="Supported",
        value=Decimal("1E+7"),
        inputs=[],
        reasons=[],
        next_step="Review the inputs",
    )
    assert result.model_dump(mode="json")["value"] == "10000000"
    evidence = InputEvidence(
        year_start=2023,
        field="revenue",
        unit="rupees",
        figure=FinancialValue(raw="0", reviewed=True),
        normalized_inr=Decimal("0.00"),
    )
    assert evidence.model_dump(mode="json")["normalized_inr"] == "0.00"
    for invalid in (None, Decimal("NaN"), Decimal("Infinity")):
        with pytest.raises(ValidationError):
            IndicatorResult(**{**result.model_dump(), "value": invalid})
    with pytest.raises(ValidationError):
        IndicatorResult(**{**result.model_dump(), "state": "Not assessed"})
    unsupported = IndicatorResult(
        **{
            **result.model_dump(),
            "state": "Not assessed",
            "value": None,
            "reasons": [
                Reason(
                    code="missing_input",
                    message="Supply current liabilities",
                    fields=["current_liabilities"],
                )
            ],
        }
    )
    assert unsupported.model_dump(mode="json")["value"] is None
    with pytest.raises(ValidationError):
        PeriodAnalysis(year_start=2023, indicators=[result] * 6)


@pytest.mark.parametrize("today,status", [("2026-03-31", 422), ("2026-04-01", 200)])
def test_year_must_have_finished_before_today(
    client, payload, monkeypatch, today, status
):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime.fromisoformat(today).replace(tzinfo=tz)

    monkeypatch.setattr("app.schemas.datetime", Clock)
    payload["periods"][0]["year_start"] = 2025
    assert client.post("/api/validate", json=payload).status_code == status


def test_reference_fixture_validates_without_changing_amounts(client):
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "aster_components.json").read_text()
    )
    request = fixture["request"]
    validated = AnalysisRequest.model_validate(request)
    assert validated.periods[1].values["interest_expense"].amount == Decimal(
        "400000.00"
    )
    response = client.post("/api/validate", json=request)
    assert response.status_code == 200
    assert response.json() == validated.model_dump(mode="json")
