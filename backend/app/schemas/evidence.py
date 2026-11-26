from typing import Annotated, Literal
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator

from app.schemas.base import Model
from app.schemas.financial import EvidenceState, Indicator


MAX_TOP_K = 6
MODEL_MAX_TOKENS = 256
QueryText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]


class PassageFilters(Model):
    top_k: int = Field(default=MAX_TOP_K, ge=1, le=MAX_TOP_K)
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


class RetrievalRequest(PassageFilters):
    query: QueryText


class RetrievedPassage(Model):
    chunk_id: UUID
    document_id: UUID
    filename: str
    chunk_index: int = Field(ge=0)
    page_number: int = Field(ge=1, le=50)
    section: str | None = None
    period_years: list[int] = Field(default_factory=list)
    content: str
    token_count: int = Field(ge=1, le=MODEL_MAX_TOKENS)
    score: float


class RetrievalResponse(Model):
    embedding_model: str
    max_tokens: int = Field(ge=1, le=MODEL_MAX_TOKENS)
    passages: list[RetrievedPassage] = Field(default_factory=list)


class QARequest(PassageFilters):
    question: QueryText


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
    mode: Literal["model", "fallback", "deterministic"]
    model: str | None = None
    fallback_reason: str | None = None
    retrieval_status: Literal["ok", "no_documents", "unavailable"]
    retrieval_note: str | None = None
    input_revision: int = Field(ge=1)
    rule_version: Literal["financial-rules-v1"]
    financial_citations: list[FinancialCitation] = Field(default_factory=list)
    document_citations: list[DocumentCitation] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
