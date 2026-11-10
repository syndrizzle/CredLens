from decimal import Context, Decimal, localcontext, ROUND_HALF_UP

from app.schemas import (
    AnalysisRequest, AnalysisResponse, BalanceCheck, FinancialField, FinancialPeriod,
    FinancialValue, Indicator, IndicatorResult, InputEvidence, PeriodAnalysis, Reason, EvidenceState,
)


MULTIPLIERS = {"rupees": 1, "thousands": 1000, "lakhs": 100000, "crores": 10000000}
DEPENDENCIES: dict[Indicator, tuple[FinancialField, ...]] = {
    "revenue_growth": ("revenue",),
    "net_profit_margin": ("profit_after_tax", "revenue"),
    "working_capital": ("current_assets", "current_liabilities"),
    "current_ratio": ("current_assets", "current_liabilities"),
    "debt_to_equity": ("short_term_borrowings", "long_term_borrowings", "current_maturities", "total_equity"),
    "interest_coverage": ("ebit", "interest_expense"),
}
SIGNED_FIELDS = {"profit_after_tax", "ebit", "total_equity"}
REVIEW_CODES = {"unreviewed", "negative_input", "comparability_unconfirmed", "balance_mismatch", "component_exceeds_total"}
BALANCE_CONFLICTS = {"balance_mismatch", "component_exceeds_total"}
NEXT_STEPS = {
    "revenue_growth": "Review the comparable revenue figures and investigate the change using supporting records.",
    "net_profit_margin": "Review profit, revenue, and supporting expense detail with your accountant before attributing a cause.",
    "working_capital": "Review the timing of current asset receipts and current liability payments.",
    "current_ratio": "Check the composition of current assets and liabilities; this ratio alone does not establish cash availability.",
    "debt_to_equity": "Verify borrowing components, count current maturities once, and disclose that leases are excluded.",
    "interest_coverage": "Verify the EBIT and interest figures; this historical ratio does not establish future repayment ability.",
}


def evidence(period: FinancialPeriod, field: FinancialField) -> InputEvidence:
    figure = period.values.get(field, FinancialValue())
    amount = figure.amount
    return InputEvidence(
        year_start=period.year_start, field=field, unit=period.unit,
        figure=figure.model_copy(),
        normalized_inr=None if amount is None else amount * MULTIPLIERS[period.unit],
    )


def input_reasons(inputs: list[InputEvidence]) -> list[Reason]:
    reasons = []
    for item in inputs:
        label = f"{item.field.replace('_', ' ')} for FY {item.year_start}-{item.year_start + 1}"
        if item.normalized_inr is None:
            reasons.append(Reason(code="missing_input", message=f"Supply {label}.", fields=[item.field]))
            continue
        if not item.figure.reviewed:
            reasons.append(Reason(code="unreviewed", message=f"Review {label}.", fields=[item.field]))
        if item.normalized_inr < 0 and item.field not in SIGNED_FIELDS:
            reasons.append(Reason(code="negative_input", message=f"Resolve the negative {label}.", fields=[item.field]))
    return reasons


def evidence_state(reasons: list[Reason]) -> EvidenceState:
    if any(reason.code in REVIEW_CODES for reason in reasons):
        return "Needs review"
    if any(reason.code in {"missing_input", "missing_prior_year"} for reason in reasons):
        return "Not assessed"
    return "Not meaningful" if reasons else "Supported"


def check_balance(period: FinancialPeriod) -> BalanceCheck:
    inputs = [evidence(period, key) for key in (
        "total_assets", "total_liabilities", "total_equity", "current_assets", "current_liabilities",
    )]
    reasons = input_reasons(inputs[:3])
    tolerance = Decimal("0.015") * MULTIPLIERS[period.unit]
    difference = None
    if not reasons:
        assets, liabilities, equity = [item.normalized_inr for item in inputs[:3]]
        difference = assets - liabilities - equity
        if abs(difference) > tolerance:
            reasons.append(Reason(
                code="balance_mismatch", message="Resolve assets versus liabilities plus equity before using balance-sheet findings.",
                fields=["total_assets", "total_liabilities", "total_equity"],
            ))
    for component, total in ((inputs[3], inputs[0]), (inputs[4], inputs[1])):
        if not input_reasons([component, total]) and component.normalized_inr > total.normalized_inr:
            reasons.append(Reason(
                code="component_exceeds_total", message=f"Resolve {component.field.replace('_', ' ')} exceeding {total.field.replace('_', ' ')}.",
                fields=[component.field, total.field],
            ))
    return BalanceCheck(state=evidence_state(reasons), difference_inr=difference,
                        tolerance_inr=tolerance, inputs=inputs, reasons=reasons)


def indicator_result(indicator: Indicator, period: FinancialPeriod,
                     prior: FinancialPeriod | None, balance: BalanceCheck) -> IndicatorResult:
    inputs = [evidence(period, field) for field in DEPENDENCIES[indicator]]
    reasons = []
    if indicator == "revenue_growth":
        if prior is None:
            reasons.append(Reason(code="missing_prior_year", message=f"Supply the immediately preceding financial year starting {period.year_start - 1}.", fields=["revenue"]))
        else:
            inputs.append(evidence(prior, "revenue"))
            if not period.comparable_to_prior:
                reasons.append(Reason(code="comparability_unconfirmed", message="Confirm that the consecutive years use a comparable reporting basis.", fields=["revenue"]))
    reasons.extend(input_reasons(inputs))
    values = [item.normalized_inr for item in inputs]

    if indicator != "working_capital":
        denominator = inputs[-1] if indicator != "revenue_growth" or prior else None
        if denominator and denominator.figure.reviewed and denominator.normalized_inr is not None:
            invalid = denominator.normalized_inr == 0
            if indicator == "debt_to_equity":
                invalid = denominator.normalized_inr <= 0
            if invalid:
                reasons.append(Reason(code="invalid_denominator", message=f"{denominator.field.replace('_', ' ').capitalize()} must be positive for this ratio to be meaningful.", fields=[denominator.field]))

    if indicator in {"working_capital", "current_ratio", "debt_to_equity"}:
        conflicts = [reason for reason in balance.reasons if reason.code in BALANCE_CONFLICTS]
        reasons.extend(conflicts)
        if conflicts:
            known = {(item.year_start, item.field) for item in inputs}
            inputs.extend(item for item in balance.inputs if (item.year_start, item.field) not in known)

    state = evidence_state(reasons)
    value = None
    if state == "Supported":
        if indicator == "revenue_growth":
            value = 100 * (values[0] - values[1]) / values[1]
        elif indicator == "net_profit_margin":
            value = 100 * values[0] / values[1]
        elif indicator == "working_capital":
            value = values[0] - values[1]
        elif indicator == "debt_to_equity":
            value = sum(values[:3]) / values[3]
        else:
            value = values[0] / values[1]

    ordered = sorted(reasons, key=lambda reason: 0 if reason.code in REVIEW_CODES else 1)
    next_step = " ".join(reason.message for reason in ordered)
    if not next_step:
        next_step = NEXT_STEPS[indicator]
    return IndicatorResult(indicator=indicator, state=state, value=value,
                           inputs=inputs, reasons=reasons, next_step=next_step)


def analyse(request: AnalysisRequest) -> AnalysisResponse:
    # Use a fresh context so callers cannot change financial precision or rounding.
    with localcontext(Context(prec=34, rounding=ROUND_HALF_UP)):
        periods = {period.year_start: period for period in request.periods}
        results = []
        for year, period in sorted(periods.items()):
            balance = check_balance(period)
            results.append(PeriodAnalysis(
                year_start=year, balance_check=balance,
                indicators=[indicator_result(key, period, periods.get(year - 1), balance)
                            for key in DEPENDENCIES],
            ))
        return AnalysisResponse(periods=results)
