from datetime import datetime
from typing import Literal
from uuid import UUID

from app.schemas.base import Model


AUDIT_RESOURCES = {
    "account_registered": "account",
    "session_login": "session",
    "session_logout": "session",
    "workspace_created": "workspace",
    "workspace_updated": "workspace",
    "workspace_deleted": "workspace",
    "analysis_run_created": "analysis_run",
    "document_uploaded": "document",
    "document_retried": "document",
    "document_extracted": "document",
    "document_deleted": "document",
    "report_generated": "report",
    "qa_asked": "qa",
}


class AuditEventSummary(Model):
    id: UUID
    owner_id: UUID
    action: Literal[
        "account_registered",
        "session_login",
        "session_logout",
        "workspace_created",
        "workspace_updated",
        "workspace_deleted",
        "analysis_run_created",
        "document_uploaded",
        "document_retried",
        "document_extracted",
        "document_deleted",
        "report_generated",
        "qa_asked",
    ]
    resource_type: Literal[
        "account",
        "session",
        "workspace",
        "analysis_run",
        "document",
        "report",
        "qa",
    ]
    resource_id: UUID | None = None
    business_id: UUID | None = None
    details: dict[str, str | int | bool | None] | None = None
    created_at: datetime
