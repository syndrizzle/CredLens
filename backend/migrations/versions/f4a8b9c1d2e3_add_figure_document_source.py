"""add figure document source

Revision ID: f4a8b9c1d2e3
Revises: e519a47c8b14
Create Date: 2026-11-20 12:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "f4a8b9c1d2e3"
down_revision: Union[str, Sequence[str], None] = "e519a47c8b14"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("figures", sa.Column("source_document_id", sa.Uuid(), nullable=True))
    op.add_column(
        "figures",
        sa.Column(
            "source_meta", postgresql.JSONB(astext_type=sa.Text()), nullable=True
        ),
    )
    op.create_index(
        "ix_figures_source_document_id",
        "figures",
        ["source_document_id"],
        unique=False,
    )
    op.create_foreign_key(
        "figures_source_document_id_fkey",
        "figures",
        "documents",
        ["source_document_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.drop_constraint("figure_origin", "figures", type_="check")
    op.create_check_constraint(
        "figure_origin", "figures", "origin IN ('manual', 'document')"
    )
    op.create_check_constraint(
        "figure_source",
        "figures",
        "(origin = 'manual' AND source_document_id IS NULL AND source_meta IS NULL) "
        "OR (origin = 'document' AND normalized_inr IS NOT NULL AND source_meta IS NOT NULL)",
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("figure_source", "figures", type_="check")
    op.drop_constraint("figure_origin", "figures", type_="check")
    op.create_check_constraint("figure_origin", "figures", "origin = 'manual'")
    op.drop_constraint("figures_source_document_id_fkey", "figures", type_="foreignkey")
    op.drop_index("ix_figures_source_document_id", table_name="figures")
    op.drop_column("figures", "source_meta")
    op.drop_column("figures", "source_document_id")
