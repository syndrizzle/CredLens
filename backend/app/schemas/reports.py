from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field

from app.schemas.base import Model
from app.schemas.financial import (
    AnalysisRequest,
    AnalysisResponse,
    EvidenceState,
    FinancialField,
    Indicator,
)


class ReportSummary(Model):
    report_id: UUID
    business_id: UUID
    report_version: int = Field(ge=1)
    input_revision: int = Field(ge=1)
    current_input_revision: int = Field(ge=1)
    rule_version: str
    action_version: str | None = None
    superseded: bool
    superseded_reason: str | None = None
    created_at: datetime


class ReportMissingEvidenceItem(Model):
    year_start: int = Field(ge=1, le=9998)
    fields: list[FinancialField] = Field(default_factory=list)
    code: str
    state: EvidenceState
    message: str
    affected_analyses: list[Indicator | Literal["balance_check"]] = Field(
        default_factory=list
    )


class ReportDocumentReference(Model):
    document_id: UUID | None = None
    filename: str
    pages: list[int] = Field(default_factory=list)
    detached: bool = False


class PreparationReportResponse(ReportSummary):
    report_schema_version: Literal["preparation-report-v1"] = "preparation-report-v1"
    business_name: str
    currency: Literal["INR"]
    basis: Literal["standalone"]
    inputs: AnalysisRequest
    analysis: AnalysisResponse
    missing_evidence: list[ReportMissingEvidenceItem] = Field(default_factory=list)
    documents_referenced: list[ReportDocumentReference] = Field(default_factory=list)
    limitations: list[str] = Field(default_factory=list)
