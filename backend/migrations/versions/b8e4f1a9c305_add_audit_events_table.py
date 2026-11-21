"""add audit events table

Revision ID: b8e4f1a9c305
Revises: a7c3d9e2f104
Create Date: 2026-11-21 20:30:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "b8e4f1a9c305"
down_revision: Union[str, Sequence[str], None] = "a7c3d9e2f104"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("resource_type", sa.String(length=32), nullable=False),
        sa.Column("resource_id", sa.Uuid(), nullable=True),
        sa.Column("business_id", sa.Uuid(), nullable=True),
        sa.Column(
            "details",
            postgresql.JSONB(none_as_null=True, astext_type=sa.Text()),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "action IN ('account_registered','session_login','session_logout','workspace_created','workspace_updated','workspace_deleted','analysis_run_created','document_uploaded','document_retried','document_extracted','document_deleted','report_generated','qa_asked')",
            name="audit_action",
        ),
        sa.CheckConstraint(
            "resource_type IN ('account','session','workspace','analysis_run','document','report','qa')",
            name="audit_resource_type",
        ),
        sa.ForeignKeyConstraint(["owner_id"], ["owners.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_audit_events_owner_id",
        "audit_events",
        ["owner_id"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_business_id",
        "audit_events",
        ["business_id"],
        unique=False,
    )
    op.create_index(
        "ix_audit_events_owner_created",
        "audit_events",
        ["owner_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_audit_events_owner_created", table_name="audit_events")
    op.drop_index("ix_audit_events_business_id", table_name="audit_events")
    op.drop_index("ix_audit_events_owner_id", table_name="audit_events")
    op.drop_table("audit_events")
