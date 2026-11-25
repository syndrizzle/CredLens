from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import Field

from app.schemas.base import Model
from app.schemas.documents import DocumentSummary
from app.schemas.financial import AnalysisRequest, AnalysisResponse


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



class WorkspaceResponse(Model):
    business_id: UUID
    input_revision: int
    request: AnalysisRequest
    latest_run_id: UUID | None = None
    latest_analysis: AnalysisResponse | None = None
    runs: list[AnalysisRunSummary] = Field(default_factory=list)
    documents: list[DocumentSummary] = Field(default_factory=list)


class WorkspaceDeleteResponse(Model):
    status: Literal["deleted"] = "deleted"
    business_id: UUID
    documents_removed: int = Field(ge=0)
    runs_removed: int = Field(ge=0)
    revisions_removed: int = Field(ge=0)
    chat_note: str
    backup_notice: str
