import re
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal, Self
from uuid import UUID
from zoneinfo import ZoneInfo

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    StringConstraints,
    field_validator,
    model_validator,
)

FinancialField = Literal[
    "revenue",
    "profit_after_tax",
    "ebit",
    "interest_expense",
    "current_assets",
    "current_liabilities",
    "total_assets",
    "total_liabilities",
    "total_equity",
    "short_term_borrowings",
    "long_term_borrowings",
    "current_maturities",
]
Unit = Literal["rupees", "thousands", "lakhs", "crores"]
Indicator = Literal[
    "revenue_growth",
    "net_profit_margin",
    "working_capital",
    "current_ratio",
    "debt_to_equity",
    "interest_coverage",
]
EvidenceState = Literal["Supported", "Needs review", "Not assessed", "Not meaningful"]
DecimalValue = Annotated[
    Decimal,
    PlainSerializer(
        lambda value: format(value, "f"), return_type=str, when_used="json"
    ),
]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class FigureSource(Model):
    document_id: UUID | None = None
    filename: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)
    ]
    page_number: int = Field(ge=1, le=50)
    table_index: int = Field(ge=1, le=10)
    row_index: int = Field(ge=2, le=250)
    column_index: int = Field(ge=2, le=16)
    label: str = Field(min_length=1, max_length=1_000)
    raw_token: str = Field(min_length=1, max_length=1_000)

    @field_validator("document_id", mode="before")
    @classmethod
    def parse_document_id(cls, value: object) -> UUID | None:
        if value is None or isinstance(value, UUID):
            return value
        if isinstance(value, str):
            try:
                return UUID(value)
            except ValueError:
                pass
        raise ValueError("Document ID must be a valid UUID or null")


class FinancialValue(Model):
    raw: str | None = Field(default=None, max_length=64)
    reviewed: bool = False
    revision: int = Field(default=1, ge=1)
    origin: Literal["manual", "document"] = "manual"
    source: FigureSource | None = None

    @field_validator("raw")
    @classmethod
    def validate_amount(cls, value: str | None) -> str | None:
        if value is not None and value.strip():
            if not re.fullmatch(r"[+-]?[0-9]{1,15}(?:\.[0-9]{1,2})?", value.strip()):
                raise ValueError(
                    "Use plain decimal text with at most 15 integer and 2 decimal digits"
                )
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
        if self.origin == "document":
            if self.amount is None:
                raise ValueError("A missing figure cannot have document origin")
            if self.source is None:
                raise ValueError(
                    "Document-origin figures require a document source reference"
                )
        elif self.source is not None:
            raise ValueError(
                "Manual-origin figures must not include a document source reference"
            )
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
    business_name: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)
    ]
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


class ActionInput(Model):
    year_start: int
    field: FinancialField


class ActionTarget(Model):
    year_start: int
    indicator: Indicator | Literal["balance_check"]


class PreparationAction(Model):
    category: Literal["review", "missing", "interpretation", "investigate"]
    code: str
    message: str
    inputs: list[ActionInput] = Field(min_length=1)
    targets: list[ActionTarget] = Field(min_length=1)


class AnalysisResponse(Model):
    rule_version: Literal["financial-rules-v1"] = "financial-rules-v1"
    action_version: Literal["preparation-actions-v1"] | None = None
    actions: list[PreparationAction] = Field(default_factory=list)
    limitations: list[str] = Field(
        default_factory=lambda: [
            "Financial rules are provisional pending finance-reviewer validation.",
            "Cash generation is not assessed; no cash-flow statement was analysed.",
            "Borrowings exclude leases and count current maturities once.",
        ]
    )
    periods: list[PeriodAnalysis] = Field(min_length=1, max_length=3)

    @model_validator(mode="after")
    def versioned_actions(self) -> Self:
        if bool(self.actions) != (self.action_version is not None):
            raise ValueError(
                "Preparation actions require their version; legacy responses have neither"
            )
        return self


class CredentialsRequest(Model):
    email: Annotated[
        str,
        StringConstraints(
            strip_whitespace=True, to_lower=True, min_length=3, max_length=254
        ),
    ]
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


class UpdateBusinessRequest(AnalysisRequest):
    expected_revision: int = Field(ge=1)


class BusinessSummary(Model):
    id: UUID
    business_name: str
    input_revision: int


class AnalysisRunSummary(Model):
    run_id: UUID
    input_revision: int = Field(ge=1)
    rule_version: str
    action_version: str | None = None
    superseded: bool
    created_at: datetime


class AnalysisRunResponse(AnalysisResponse):
    run_id: UUID
    business_id: UUID
    input_revision: int = Field(ge=1)
    superseded: bool
    created_at: datetime

    def __eq__(self, other: object) -> bool:
        if type(other) is AnalysisResponse:
            return (
                AnalysisResponse.model_construct(
                    **{k: getattr(self, k) for k in AnalysisResponse.model_fields}
                )
                == other
            )
        return super().__eq__(other)


class DocumentSummary(Model):
    id: UUID
    business_id: UUID
    filename: str
    sha256: str
    byte_size: int = Field(ge=1, le=20971520)
    page_count: int | None = Field(default=None, ge=1, le=50)
    extracted_char_count: int | None = Field(default=None, ge=0)
    status: Literal["processing", "ready", "failed"]
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime
    updated_at: datetime


CandidateIssueCode = Literal[
    "missing_value",
    "invalid_amount",
    "ambiguous_mapping",
    "missing_unit",
    "conflicting_unit",
    "missing_period",
    "conflicting_period",
    "missing_basis",
    "conflicting_basis",
    "duplicate_match",
    "conflicting_match",
]
UNIT_MULTIPLIERS: dict[str, int] = {
    "rupees": 1,
    "thousands": 1_000,
    "lakhs": 100_000,
    "crores": 10_000_000,
}


NOTE_HEADERS = {
    "note",
    "notes",
    "note no",
    "note no.",
    "note ref",
    "note reference",
    "schedule",
}


class ExtractedTable(Model):
    table_index: int = Field(ge=1, le=10)
    rows: list[list[str]] = Field(min_length=1, max_length=250)

    @model_validator(mode="after")
    def check_cells(self) -> Self:
        for row in self.rows:
            if not 1 <= len(row) <= 16:
                raise ValueError("Extracted table rows must have 1 to 16 columns")
            if any(len(cell) > 1_000 for cell in row):
                raise ValueError(
                    "Extracted table cells must not exceed 1,000 characters"
                )
        return self


class ExtractedPage(Model):
    page_number: int = Field(ge=1, le=50)
    text: str = Field(max_length=50_000)
    tables: list[ExtractedTable] = Field(default_factory=list, max_length=10)
    statement_title: str | None = Field(default=None, max_length=1_000)
    basis: Literal["standalone"] | None = None
    basis_context: str | None = Field(default=None, max_length=1_000)
    period_context: str | None = Field(default=None, max_length=1_000)
    unit: Unit | None = None
    multiplier: int | None = None
    unit_header: str | None = Field(default=None, max_length=1_000)
    issues: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_page_unit(self) -> Self:
        if (self.unit is None) != (self.multiplier is None):
            raise ValueError(
                "Page unit and multiplier must both be set or both be null"
            )
        if self.unit is not None and UNIT_MULTIPLIERS[self.unit] != self.multiplier:
            raise ValueError("Page unit and multiplier do not match")
        if sum(len(table.rows) for table in self.tables) > 250:
            raise ValueError("Extracted page exceeds maximum table row budget")
        return self


class ExtractedCandidate(Model):
    page_number: int = Field(ge=1, le=50)
    table_index: int = Field(ge=1, le=10)
    row_index: int = Field(ge=1, le=250)
    column_index: int = Field(ge=1, le=16)
    field: FinancialField | None = None
    label: str = Field(max_length=1_000)
    note: str | None = Field(default=None, max_length=1_000)
    raw: str = Field(max_length=1_000)
    source_row: list[str] = Field(min_length=1, max_length=16)
    source_context: list[str] = Field(default_factory=list, max_length=20)
    period_header: str = Field(max_length=1_000)
    period_context: str | None = Field(default=None, max_length=1_000)
    year_start: int | None = Field(default=None, ge=1, le=9998)
    unit_header: str | None = Field(default=None, max_length=1_000)
    unit: Unit | None = None
    multiplier: int | None = None
    basis: Literal["standalone"] | None = None
    basis_context: str | None = Field(default=None, max_length=1_000)
    amount: DecimalValue | None = None
    normalized_inr: DecimalValue | None = None
    reviewed: Literal[False] = False
    issues: list[CandidateIssueCode] = Field(default_factory=list, max_length=12)

    @field_validator("amount", "normalized_inr", mode="before")
    @classmethod
    def parse_decimal_string(cls, value: object) -> Decimal | None:
        if value is None or isinstance(value, Decimal):
            return value
        if isinstance(value, str) and re.fullmatch(
            r"-?[0-9]{1,23}(?:\.[0-9]{1,2})?", value
        ):
            return Decimal(value)
        raise ValueError("Decimal fields require a canonical decimal string or Decimal")

    @model_validator(mode="after")
    def check_candidate(self) -> Self:
        if (self.unit is None) != (self.multiplier is None):
            raise ValueError(
                "Candidate unit and multiplier must both be set or both be null"
            )
        if self.unit is not None and UNIT_MULTIPLIERS[self.unit] != self.multiplier:
            raise ValueError("Candidate unit and multiplier do not match")
        if self.issues:
            if self.normalized_inr is not None:
                raise ValueError(
                    "Candidates with issues must not have a usable normalized INR value"
                )
        else:
            if (
                self.field is None
                or self.year_start is None
                or self.unit is None
                or self.multiplier is None
                or self.basis != "standalone"
                or self.amount is None
                or self.normalized_inr is None
            ):
                raise ValueError(
                    "Usable candidates require field, year, unit, multiplier, standalone basis, amount, and normalized INR"
                )
            if self.normalized_inr != self.amount * Decimal(self.multiplier):
                raise ValueError(
                    "Normalized INR must equal exact amount times multiplier"
                )
        return self


class DocumentExtractionSnapshot(Model):
    schema_version: Literal["document-extraction-v2"]
    document_sha256: Annotated[
        str, StringConstraints(min_length=64, max_length=64, pattern=r"^[0-9a-f]{64}$")
    ]
    layout: Literal["layout_a", "unsupported"]
    page_count: int = Field(ge=1, le=50)
    extracted_char_count: int = Field(ge=1, le=250_000)
    pages: list[ExtractedPage] = Field(min_length=1, max_length=50)
    candidates: list[ExtractedCandidate] = Field(default_factory=list, max_length=500)
    issues: list[str] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def check_snapshot_bounds(self) -> Self:
        if len(self.pages) != self.page_count:
            raise ValueError("Page list length must match page_count")
        if [page.page_number for page in self.pages] != list(
            range(1, self.page_count + 1)
        ):
            raise ValueError("Pages must be numbered sequentially from 1 to page_count")
        if sum(len(page.text) for page in self.pages) > 350_000:
            raise ValueError("Total extracted text exceeds budget")
        total_rows = sum(
            len(table.rows) for page in self.pages for table in page.tables
        )
        total_cells = sum(
            len(row)
            for page in self.pages
            for table in page.tables
            for row in table.rows
        )
        if total_rows > 2_000 or total_cells > 10_000:
            raise ValueError("Total extracted table rows or cells exceed budget")
        tables = {
            (p.page_number, t.table_index): t for p in self.pages for t in p.tables
        }
        if len(tables) != sum(len(p.tables) for p in self.pages):
            raise ValueError("Duplicate table reference")
        for candidate in self.candidates:
            table = tables.get((candidate.page_number, candidate.table_index))
            if table is None or not 2 <= candidate.row_index <= len(table.rows):
                raise ValueError("Candidate refers to an absent source row")
            row = table.rows[candidate.row_index - 1]
            header = table.rows[0]
            has_note = len(header) > 1 and header[1].lower().strip(":.") in NOTE_HEADERS
            note = row[1] if has_note and len(row) > 1 else None
            col = candidate.column_index - 1
            if not (
                (2 if has_note else 1) <= col < min(len(row), len(header))
                and candidate.note == note
                and candidate.source_row == row
                and candidate.label == row[0]
                and candidate.raw == row[col]
                and candidate.period_header == header[col]
            ):
                raise ValueError("Candidate source cell differs from retained table")
        return self


class DocumentExtractionResponse(DocumentSummary):
    extraction_status: Literal[
        "ready",
        "not_extracted",
        "refresh_required",
        "processing",
        "failed",
        "deletion_pending",
    ]
    extraction_message: str | None = None
    extraction: DocumentExtractionSnapshot | None = None

    @model_validator(mode="after")
    def check_extraction_exposure(self) -> Self:
        if self.extraction_status == "ready":
            if self.status != "ready" or self.extraction is None:
                raise ValueError(
                    "Ready extraction status requires ready document and snapshot"
                )
            if self.extraction.document_sha256 != self.sha256:
                raise ValueError(
                    "Extraction snapshot hash does not match document sha256"
                )
        elif self.extraction is not None:
            raise ValueError("Non-ready extraction status must not expose a snapshot")
        return self


class WorkspaceResponse(Model):
    business_id: UUID
    input_revision: int
    request: AnalysisRequest
    latest_run_id: UUID | None = None
    latest_analysis: AnalysisResponse | None = None
    runs: list[AnalysisRunSummary] = Field(default_factory=list)
    documents: list[DocumentSummary] = Field(default_factory=list)


class RetrievalRequest(Model):
    query: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
    ]
    top_k: int = Field(default=6, ge=1, le=6)
    year_start: int | None = Field(default=None, ge=1, le=9998)
    document_id: UUID | None = None

    @field_validator("document_id", mode="before")
    @classmethod
    def parse_document_id(cls, value: object) -> UUID | None:
        if value is None or isinstance(value, UUID):
            return value
        if isinstance(value, str):
            try:
                return UUID(value)
            except ValueError:
                pass
        raise ValueError("Document ID must be a valid UUID or null")


class RetrievedPassage(Model):
    chunk_id: UUID
    document_id: UUID
    filename: str
    chunk_index: int = Field(ge=0)
    page_number: int = Field(ge=1, le=50)
    section: str | None = None
    period_years: list[int] = Field(default_factory=list)
    content: str
    token_count: int = Field(ge=1, le=256)
    score: float


class RetrievalResponse(Model):
    embedding_model: str
    max_tokens: int = Field(ge=1, le=256)
    passages: list[RetrievedPassage] = Field(default_factory=list)


class QARequest(Model):
    question: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
    ]
    top_k: int = Field(default=6, ge=1, le=6)
    year_start: int | None = Field(default=None, ge=1, le=9998)
    document_id: UUID | None = None

    @field_validator("document_id", mode="before")
    @classmethod
    def parse_document_id(cls, value: object) -> UUID | None:
        if value is None or isinstance(value, UUID):
            return value
        if isinstance(value, str):
            try:
                return UUID(value)
            except ValueError:
                pass
        raise ValueError("Document ID must be a valid UUID or null")


class FinancialCitation(Model):
    citation_id: Annotated[str, StringConstraints(pattern=r"^F[1-9][0-9]*$")]
    year_start: int = Field(ge=1, le=9998)
    indicator: Indicator | Literal["balance_check"]
    label: str
    state: EvidenceState
    value_display: str | None = None
    summary: str
    origins: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    cited: bool = False


class DocumentCitation(Model):
    citation_id: Annotated[str, StringConstraints(pattern=r"^D[1-9][0-9]*$")]
    chunk_id: UUID
    document_id: UUID
    filename: str
    page_number: int = Field(ge=1, le=50)
    section: str | None = None
    period_years: list[int] = Field(default_factory=list)
    excerpt: str
    score: float
    cited: bool = False


class QAResponse(Model):
    question: str
    answer: str
    mode: Literal["ollama", "fallback"]
    model: str | None = None
    fallback_reason: str | None = None
    retrieval_status: Literal["ok", "no_documents", "unavailable"]
    retrieval_note: str | None = None
    input_revision: int = Field(ge=1)
    rule_version: Literal["financial-rules-v1"]
    financial_citations: list[FinancialCitation] = Field(default_factory=list)
    document_citations: list[DocumentCitation] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
