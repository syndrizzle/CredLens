from datetime import date, datetime
from decimal import Decimal
import re
from typing import Annotated, Literal, Self
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, StringConstraints, field_validator, model_validator


FinancialField = Literal[
    "revenue", "profit_after_tax", "ebit", "interest_expense",
    "current_assets", "current_liabilities", "total_assets", "total_liabilities",
    "total_equity", "short_term_borrowings", "long_term_borrowings", "current_maturities",
]
Unit = Literal["rupees", "thousands", "lakhs", "crores"]
Indicator = Literal[
    "revenue_growth", "net_profit_margin", "working_capital",
    "current_ratio", "debt_to_equity", "interest_coverage",
]
EvidenceState = Literal["Supported", "Needs review", "Not assessed", "Not meaningful"]
DecimalValue = Annotated[Decimal, PlainSerializer(lambda value: format(value, "f"), return_type=str, when_used="json")]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class FinancialValue(Model):
    raw: str | None = Field(default=None, max_length=64)
    reviewed: bool = False
    revision: int = Field(default=1, ge=1)
    origin: Literal["manual"] = "manual"

    @field_validator("raw")
    @classmethod
    def validate_amount(cls, value: str | None) -> str | None:
        if value is not None and value.strip():
            if not re.fullmatch(r"[+-]?[0-9]{1,15}(?:\.[0-9]{1,2})?", value.strip()):
                raise ValueError("Use plain decimal text with at most 15 integer and 2 decimal digits")
        return value

    @property
    def amount(self) -> Decimal | None:
        if self.raw is None or not self.raw.strip():
            return None
        return Decimal(self.raw.strip())

    @model_validator(mode="after")
    def check_review(self) -> Self:
        if self.reviewed and self.amount is None:
            raise ValueError("A missing figure cannot be marked reviewed")
        return self


class FinancialPeriod(Model):
    year_start: int = Field(ge=1, le=9998)
    unit: Unit
    comparable_to_prior: bool = False
    values: dict[FinancialField, FinancialValue] = Field(default_factory=dict)

    @field_validator("year_start")
    @classmethod
    def completed_year(cls, year: int) -> int:
        today = datetime.now(ZoneInfo("Asia/Kolkata")).date()
        if date(year + 1, 3, 31) >= today:
            raise ValueError("Only completed April-March financial years are supported")
        return year


class AnalysisRequest(Model):
    business_name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    currency: Literal["INR"] = "INR"
    basis: Literal["standalone"] = "standalone"
    periods: list[FinancialPeriod] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def unique_years(self) -> Self:
        years = [period.year_start for period in self.periods]
        if len(years) != len(set(years)):
            raise ValueError("Financial years must be distinct")
        return self


class InputEvidence(Model):
    year_start: int
    field: FinancialField
    unit: Unit
    figure: FinancialValue
    normalized_inr: DecimalValue | None


class Reason(Model):
    code: str
    message: str
    fields: list[FinancialField] = Field(default_factory=list)


class IndicatorResult(Model):
    indicator: Indicator
    state: EvidenceState
    value: DecimalValue | None
    inputs: list[InputEvidence]
    reasons: list[Reason]
    next_step: str

    @model_validator(mode="after")
    def consistent_state(self) -> Self:
        if self.state == "Supported":
            if self.value is None:
                raise ValueError("Supported results require a value")
        elif self.value is not None or not self.reasons:
            raise ValueError("Unsupported results require reasons and no numeric value")
        return self


class BalanceCheck(Model):
    state: EvidenceState
    difference_inr: DecimalValue | None
    tolerance_inr: DecimalValue
    inputs: list[InputEvidence]
    reasons: list[Reason]


class PeriodAnalysis(Model):
    year_start: int
    indicators: list[IndicatorResult] = Field(min_length=6, max_length=6)
    balance_check: BalanceCheck

    @model_validator(mode="after")
    def distinct_indicators(self) -> Self:
        if len({result.indicator for result in self.indicators}) != 6:
            raise ValueError("Each of the six indicators must appear once")
        return self


class AnalysisResponse(Model):
    rule_version: Literal["financial-rules-v1"] = "financial-rules-v1"
    limitations: list[str] = Field(default_factory=lambda: [
        "Financial rules are provisional pending finance-reviewer validation.",
        "Cash generation is not assessed; no cash-flow statement was analysed.",
        "Borrowings exclude leases and count current maturities once.",
    ])
    periods: list[PeriodAnalysis] = Field(min_length=1, max_length=3)


class CredentialsRequest(Model):
    email: Annotated[str, StringConstraints(strip_whitespace=True, to_lower=True, min_length=3, max_length=254)]
    password: Annotated[str, StringConstraints(min_length=12, max_length=128)]

    @field_validator("email")
    @classmethod
    def check_email(cls, value: str) -> str:
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
            raise ValueError("Enter a valid email address")
        return value


class SessionResponse(Model):
    owner_id: UUID
    email: str


class BusinessSummary(Model):
    id: UUID
    business_name: str
    input_revision: int


class WorkspaceResponse(Model):
    business_id: UUID
    input_revision: int
    request: AnalysisRequest
    latest_run_id: UUID | None = None
    latest_analysis: AnalysisResponse | None = None
