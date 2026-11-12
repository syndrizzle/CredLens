"""reviewer and revision history

Revision ID: c491e82a10bf
Revises: 7c84f91a3d02
Create Date: 2026-11-12 16:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c491e82a10bf'
down_revision: Union[str, Sequence[str], None] = '7c84f91a3d02'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('revisions',
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('input_revision', sa.Integer(), nullable=False),
    sa.Column('actor_id', sa.Uuid(), nullable=False),
    sa.Column('inputs', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('input_revision > 0', name='revision_number'),
    sa.ForeignKeyConstraint(['actor_id'], ['owners.id'], ),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('business_id', 'input_revision')
    )
    op.add_column('figures', sa.Column('reviewed_by', sa.Uuid(), nullable=True))
    op.execute(sa.text(
        "UPDATE figures AS f SET reviewed_by = b.owner_id "
        "FROM periods AS p JOIN businesses AS b ON b.id = p.business_id "
        "WHERE f.period_id = p.id AND f.reviewed = TRUE AND f.reviewed_by IS NULL"
    ))
    op.create_foreign_key('figures_reviewed_by_fkey', 'figures', 'owners', ['reviewed_by'], ['id'])
    op.create_check_constraint('figure_reviewer', 'figures', 'reviewed = (reviewed_by IS NOT NULL)')


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_constraint('figure_reviewer', 'figures', type_='check')
    op.drop_constraint('figures_reviewed_by_fkey', 'figures', type_='foreignkey')
    op.drop_column('figures', 'reviewed_by')
    op.drop_table('revisions')
