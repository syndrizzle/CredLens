import json
from decimal import Decimal, localcontext, Inexact
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.analysis import analyse
from app.main import app
from app.schemas import AnalysisRequest


@pytest.fixture
def payload():
    data = json.loads((Path(__file__).parent / "fixtures/aster_components.json").read_text())["request"]
    for period in data["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = True
    return data


def results(payload):
    response = analyse(AnalysisRequest.model_validate(payload))
    return {item.indicator: item for item in response.periods[-1].indicators}


def test_reference_results_and_no_input_mutation(payload):
    request = AnalysisRequest.model_validate(payload)
    before = request.model_dump()
    response = analyse(request)
    expected = [
        [None, "9", "2000000", "2", "0.3", "5"],
        ["20", "5", "2500000", "2", "0.3", "3"],
    ]
    for period, values in zip(response.periods, expected):
        for item, value in zip(period.indicators, values):
            assert item.value == (Decimal(value) if value is not None else None)
            assert item.state == ("Supported" if value is not None else "Not assessed")
        assert period.balance_check.difference_inr == 0
        assert period.balance_check.state == "Supported"
    assert request.model_dump() == before


@pytest.mark.parametrize("field,affected", [
    ("revenue", {"revenue_growth", "net_profit_margin"}),
    ("profit_after_tax", {"net_profit_margin"}),
    ("ebit", {"interest_coverage"}), ("interest_expense", {"interest_coverage"}),
    ("current_assets", {"working_capital", "current_ratio"}),
    ("current_liabilities", {"working_capital", "current_ratio"}),
    ("total_equity", {"debt_to_equity"}),
    ("short_term_borrowings", {"debt_to_equity"}),
    ("long_term_borrowings", {"debt_to_equity"}),
    ("current_maturities", {"debt_to_equity"}),
])
@pytest.mark.parametrize("problem,state", [("missing", "Not assessed"), ("unreviewed", "Needs review")])
def test_dependency_isolation(payload, field, affected, problem, state):
    values = payload["periods"][1]["values"]
    if problem == "missing":
        del values[field]
    else:
        values[field]["reviewed"] = False
    for key, result in results(payload).items():
        assert result.state == (state if key in affected else "Supported")
        if key in affected:
            assert result.value is None
            assert field in {f for reason in result.reasons for f in reason.fields}


@pytest.mark.parametrize("field,key", [("revenue", "net_profit_margin"), ("interest_expense", "interest_coverage"), ("current_liabilities", "current_ratio")])
def test_zero_denominators(payload, field, key):
    payload["periods"][1]["values"][field]["raw"] = "0"
    item = results(payload)[key]
    assert item.state == "Not meaningful" and item.value is None
    if field == "current_liabilities":
        assert results(payload)["working_capital"].value == Decimal("5000000")


@pytest.mark.parametrize("equity", ["0", "-1000000"])
def test_nonpositive_equity(payload, equity):
    values = payload["periods"][1]["values"]
    values["total_equity"]["raw"] = equity
    values["total_liabilities"]["raw"] = str(Decimal("12000000") - Decimal(equity))
    assert results(payload)["debt_to_equity"].state == "Not meaningful"


@pytest.mark.parametrize("field,key,value", [("profit_after_tax", "net_profit_margin", "-5"), ("ebit", "interest_coverage", "-1.5")])
def test_supported_negative_earnings(payload, field, key, value):
    payload["periods"][1]["values"][field]["raw"] = "-600000"
    item = results(payload)[key]
    assert item.state == "Supported" and item.value == Decimal(value)


@pytest.mark.parametrize("field", ["revenue", "interest_expense", "current_assets", "current_liabilities", "short_term_borrowings", "long_term_borrowings", "current_maturities"])
def test_unexpected_negative_signs_need_review(payload, field):
    payload["periods"][1]["values"][field]["raw"] = "-1"
    affected = [r for r in results(payload).values() if any(i.field == field for i in r.inputs)]
    assert affected
    assert all(r.state == "Needs review" and r.value is None for r in affected)


@pytest.mark.parametrize("unit,multiplier", [("rupees", 1), ("thousands", 1000), ("lakhs", 100000), ("crores", 10000000)])
def test_mixed_units(payload, unit, multiplier):
    period = payload["periods"][1]
    period["unit"] = unit
    for value in period["values"].values():
        value["raw"] = str(Decimal(value["raw"]) / multiplier)
    actual = results(payload)
    assert actual["revenue_growth"].value == 20
    assert actual["working_capital"].value == 2500000
    assert actual["debt_to_equity"].value == Decimal("0.3")


def test_mixed_states_retain_reasons_and_reanalyse(payload):
    figures = payload["periods"][1]["values"]
    del figures["interest_expense"]
    figures["ebit"]["reviewed"] = False
    item = results(payload)["interest_coverage"]
    assert item.state == "Needs review"
    assert {r.code for r in item.reasons} == {"unreviewed", "missing_input"}
    figures["ebit"]["reviewed"] = True
    assert results(payload)["interest_coverage"].state == "Not assessed"
    figures["interest_expense"] = {"raw": "400000", "reviewed": True, "revision": 2}
    assert results(payload)["interest_coverage"].value == 3
    assert results(payload)["interest_coverage"].inputs[-1].figure.revision == 2


@pytest.mark.parametrize("problem,state", [("missing", "Not assessed"), ("gap", "Not assessed"), ("comparison", "Needs review"), ("zero", "Not meaningful"), ("negative", "Needs review")])
def test_growth_period_rules(payload, problem, state):
    if problem == "missing":
        payload["periods"].pop(0)
    elif problem == "gap":
        payload["periods"][0]["year_start"] = 2022
    elif problem == "comparison":
        payload["periods"][1]["comparable_to_prior"] = False
    else:
        payload["periods"][0]["values"]["revenue"]["raw"] = "0" if problem == "zero" else "-1"
    assert results(payload)["revenue_growth"].state == state


@pytest.mark.parametrize("delta,blocked", [("0.01", False), ("0.02", True), ("100", True)])
def test_balance_tolerance_and_selective_blocking(payload, delta, blocked):
    payload["periods"][1]["values"]["total_liabilities"]["raw"] = str(Decimal("5000000") + Decimal(delta))
    response = analyse(AnalysisRequest.model_validate(payload)).periods[1]
    assert response.balance_check.difference_inr == -Decimal(delta)
    assert response.balance_check.tolerance_inr == Decimal("0.015")
    for item in response.indicators:
        expected = "Needs review" if blocked and item.indicator in {"working_capital", "current_ratio", "debt_to_equity"} else "Supported"
        assert item.state == expected


@pytest.mark.parametrize("field", ["total_assets", "total_liabilities"])
def test_missing_totals_do_not_block_indicators(payload, field):
    del payload["periods"][1]["values"][field]
    response = analyse(AnalysisRequest.model_validate(payload)).periods[1]
    assert response.balance_check.state == "Not assessed"
    assert all(item.state == "Supported" for item in response.indicators)


def test_component_exceeds_total_even_without_balance_equation(payload):
    figures = payload["periods"][1]["values"]
    del figures["total_liabilities"]
    figures["current_assets"]["raw"] = "12000001"
    assert results(payload)["current_ratio"].state == "Needs review"


def test_supported_zero_debt_and_negative_working_capital(payload):
    figures = payload["periods"][1]["values"]
    for field in ("short_term_borrowings", "long_term_borrowings", "current_maturities"):
        figures[field]["raw"] = "0"
    figures["current_assets"]["raw"] = "1000000"
    actual = results(payload)
    assert actual["debt_to_equity"].value == 0
    assert actual["debt_to_equity"].state == "Supported"
    assert actual["working_capital"].value == -1500000
    assert actual["working_capital"].state == "Supported"


def test_empty_case_returns_gaps_without_crashing():
    request = AnalysisRequest(business_name="Incomplete", periods=[{"year_start": 2023, "unit": "rupees"}])
    period = analyse(request).periods[0]
    assert period.balance_check.state == "Not assessed"
    assert all(item.state == "Not assessed" and item.value is None for item in period.indicators)


def test_large_amounts_and_raw_evidence_are_preserved(payload):
    period = payload["periods"][1]
    period["unit"] = "crores"
    period["values"]["revenue"]["raw"] = " +999999999999999.99 "
    item = results(payload)["net_profit_margin"]
    assert item.inputs[1].normalized_inr == Decimal("9999999999999999900000")
    assert item.inputs[1].figure.raw == " +999999999999999.99 "
    assert item.state == "Supported"


def test_decimal_context_order_and_precision_are_independent(payload):
    payload["periods"].reverse()
    payload["periods"][0]["values"]["interest_expense"]["raw"] = "7"
    with localcontext() as context:
        context.prec = 2
        context.traps[Inexact] = True
        response = analyse(AnalysisRequest.model_validate(payload))
        assert context.prec == 2
    assert [p.year_start for p in response.periods] == [2023, 2024]
    coverage = response.periods[1].indicators[-1].value
    assert coverage == Decimal("171428.5714285714285714285714285714")


def test_api_serialization_validation_and_unreviewed_fixture(payload):
    with TestClient(app) as client:
        response = client.post("/api/analysis", json=payload)
        assert response.status_code == 200
        body = response.json()
        assert body["rule_version"] == "financial-rules-v1"
        assert body["limitations"]
        assert body["periods"][1]["indicators"][0]["value"] == "20"
        assert body["periods"][1]["balance_check"]["tolerance_inr"] == "0.015"
        for period in payload["periods"]:
            for figure in period["values"].values():
                figure["reviewed"] = False
        body = client.post("/api/analysis", json=payload).json()
        assert all(i["state"] == "Needs review" for p in body["periods"] for i in p["indicators"])
        payload["periods"][0]["values"]["revenue"]["raw"] = "NaN"
        rejected = client.post("/api/analysis", json=payload)
        assert rejected.status_code == 422
        assert "input" not in rejected.json()["detail"][0]
