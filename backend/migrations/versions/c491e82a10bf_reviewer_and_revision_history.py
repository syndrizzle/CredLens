"""reviewer and revision history

Revision ID: c491e82a10bf
Revises: 7c84f91a3d02
Create Date: 2026-11-12 16:20:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "c491e82a10bf"
down_revision: Union[str, Sequence[str], None] = "7c84f91a3d02"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "revisions",
        sa.Column("business_id", sa.Uuid(), nullable=False),
        sa.Column("input_revision", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.Uuid(), nullable=False),
        sa.Column("inputs", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint("input_revision > 0", name="revision_number"),
        sa.ForeignKeyConstraint(
            ["actor_id"],
            ["owners.id"],
        ),
        sa.ForeignKeyConstraint(["business_id"], ["businesses.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("business_id", "input_revision"),
    )
    op.add_column("figures", sa.Column("reviewed_by", sa.Uuid(), nullable=True))
    op.execute(
        sa.text(
            "UPDATE figures AS f SET reviewed_by = b.owner_id "
            "FROM periods AS p JOIN businesses AS b ON b.id = p.business_id "
            "WHERE f.period_id = p.id AND f.reviewed = TRUE AND f.reviewed_by IS NULL"
        )
    )
    op.create_foreign_key(
        "figures_reviewed_by_fkey", "figures", "owners", ["reviewed_by"], ["id"]
    )
    op.create_check_constraint(
        "figure_reviewer", "figures", "reviewed = (reviewed_by IS NOT NULL)"
    )
    op.execute(
        sa.text(
            "INSERT INTO revisions (business_id, input_revision, actor_id, inputs, created_at) "
            "SELECT b.id, b.input_revision, b.owner_id, "
            "jsonb_build_object("
            "'business_name', b.name, 'currency', b.currency, 'basis', b.basis, "
            "'periods', COALESCE(("
            "SELECT jsonb_agg("
            "jsonb_build_object("
            "'year_start', p.year_start, 'unit', p.unit, 'comparable_to_prior', p.comparable_to_prior, "
            "'values', COALESCE(("
            "SELECT jsonb_object_agg("
            "f.field, jsonb_build_object('raw', f.raw, 'reviewed', f.reviewed, 'revision', f.revision, 'origin', f.origin)"
            ") FROM figures AS f WHERE f.period_id = p.id"
            "), '{}'::jsonb)"
            ") ORDER BY p.year_start"
            ") FROM periods AS p WHERE p.business_id = b.id"
            "), '[]'::jsonb)"
            "), b.created_at "
            "FROM businesses AS b "
            "ON CONFLICT (business_id, input_revision) DO NOTHING"
        )
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint("figure_reviewer", "figures", type_="check")
    op.drop_constraint("figures_reviewed_by_fkey", "figures", type_="foreignkey")
    op.drop_column("figures", "reviewed_by")
    op.drop_table("revisions")
