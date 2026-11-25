"""Owner-scoped queries shared by workspace, report and document services."""

from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import Connection
from sqlalchemy.sql.elements import ColumnElement

from app.models import businesses, documents


def owned_business(
    connection: Connection, owner_id: UUID, business_id: UUID, *, for_update: bool = False
):
    stmt = select(businesses).where(
        businesses.c.id == business_id, businesses.c.owner_id == owner_id
    )
    if for_update:
        stmt = stmt.with_for_update()
    row = connection.execute(stmt).mappings().one_or_none()
    if row is None:
        raise LookupError("Business not found")
    return row


def document_scope(owner_id: UUID, business_id: UUID) -> tuple[ColumnElement[bool], ...]:
    return documents.c.owner_id == owner_id, documents.c.business_id == business_id


def require_document(connection: Connection, owner_id: UUID, business_id: UUID, document_id: UUID) -> None:
    if connection.scalar(
        select(documents.c.id).where(*document_scope(owner_id, business_id), documents.c.id == document_id)
    ) is None:
        raise LookupError("Document not found")
