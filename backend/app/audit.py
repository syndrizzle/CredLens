"""Minimal owner-scoped audit events (actor, action, time, resource UUIDs, zero financial payloads)."""

from typing import Mapping
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.engine import Connection

from app.models import audit_events
from app.schemas.audit import AUDIT_RESOURCES, AuditEventSummary

# Callers supply operational metadata only. Reject any additional detail keys.
ALLOWED_AUDIT_DETAIL_KEYS = frozenset(
    {
        "input_revision",
        "report_version",
        "status",
        "retrieval_status",
        "documents_removed",
        "runs_removed",
        "revisions_removed",
    }
)


def sanitize_audit_details(
    details: Mapping[str, object] | None,
) -> dict[str, str | int | bool | None] | None:
    if details is None:
        return None
    sanitized: dict[str, str | int | bool | None] = {}
    for key, value in details.items():
        if key not in ALLOWED_AUDIT_DETAIL_KEYS:
            raise ValueError(f"Audit detail key not allowed: {key}")
        if value is None or isinstance(value, (bool, int)):
            sanitized[key] = value
        elif isinstance(value, str):
            trimmed = value.strip()
            if len(trimmed) > 64:
                raise ValueError(f"Audit detail string exceeds 64 characters for key: {key}")
            sanitized[key] = trimmed
        else:
            raise ValueError(f"Audit detail value must be a safe scalar for key: {key}")
    return sanitized or None


def record_audit_event(
    connection: Connection,
    owner_id: UUID,
    action: str,
    *,
    resource_id: UUID | None = None,
    business_id: UUID | None = None,
    details: Mapping[str, object] | None = None,
) -> None:
    resource_type = AUDIT_RESOURCES.get(action)
    if resource_type is None:
        raise ValueError(f"Unsupported audit action: {action}")
    safe_details = sanitize_audit_details(details)
    event_id = uuid4()
    connection.execute(
        audit_events.insert().values(
            id=event_id,
            owner_id=owner_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            business_id=business_id,
            details=safe_details,
        )
    )


def list_audit_events(
    connection: Connection,
    owner_id: UUID,
    *,
    business_id: UUID | None = None,
    limit: int = 50,
) -> list[AuditEventSummary]:
    bounded = max(1, min(limit, 100))
    stmt = (
        select(
            audit_events.c.id,
            audit_events.c.owner_id,
            audit_events.c.action,
            audit_events.c.resource_type,
            audit_events.c.resource_id,
            audit_events.c.business_id,
            audit_events.c.details,
            audit_events.c.created_at,
        )
        .where(audit_events.c.owner_id == owner_id)
        .order_by(audit_events.c.created_at.desc(), audit_events.c.id.desc())
        .limit(bounded)
    )
    if business_id is not None:
        stmt = stmt.where(audit_events.c.business_id == business_id)
    rows = connection.execute(stmt).mappings().all()
    return [AuditEventSummary(**dict(row)) for row in rows]
