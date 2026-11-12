"""initial financial persistence

Revision ID: 2b45e0cd055f
Revises: 
Create Date: 2026-11-12 14:48:14.283775

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = '2b45e0cd055f'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('owners',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('businesses',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('owner_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=120), nullable=False),
    sa.Column('currency', sa.String(length=3), nullable=False),
    sa.Column('basis', sa.String(length=20), nullable=False),
    sa.Column('input_revision', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("currency = 'INR' AND basis = 'standalone'", name='business_basis'),
    sa.CheckConstraint('input_revision > 0', name='business_revision'),
    sa.ForeignKeyConstraint(['owner_id'], ['owners.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_businesses_owner_id'), 'businesses', ['owner_id'], unique=False)
    op.create_table('analysis_runs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('input_revision', sa.Integer(), nullable=False),
    sa.Column('rule_version', sa.Text(), nullable=False),
    sa.Column('inputs', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('results', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('input_revision > 0', name='run_revision'),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_analysis_runs_business_id'), 'analysis_runs', ['business_id'], unique=False)
    op.create_table('periods',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('business_id', sa.Uuid(), nullable=False),
    sa.Column('year_start', sa.Integer(), nullable=False),
    sa.Column('unit', sa.String(length=20), nullable=False),
    sa.Column('multiplier', sa.Integer(), nullable=False),
    sa.Column('comparable_to_prior', sa.Boolean(), nullable=False),
    sa.CheckConstraint("(unit = 'rupees' AND multiplier = 1) OR (unit = 'thousands' AND multiplier = 1000) OR (unit = 'lakhs' AND multiplier = 100000) OR (unit = 'crores' AND multiplier = 10000000)", name='period_unit'),
    sa.CheckConstraint('year_start BETWEEN 1 AND 9998', name='period_year'),
    sa.ForeignKeyConstraint(['business_id'], ['businesses.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('business_id', 'year_start', name='period_business_year')
    )
    op.create_table('figures',
    sa.Column('period_id', sa.Uuid(), nullable=False),
    sa.Column('field', sa.String(length=40), nullable=False),
    sa.Column('raw', sa.String(length=64), nullable=True),
    sa.Column('normalized_inr', sa.Numeric(), nullable=True),
    sa.Column('origin', sa.String(length=20), nullable=False),
    sa.Column('reviewed', sa.Boolean(), nullable=False),
    sa.Column('revision', sa.Integer(), nullable=False),
    sa.CheckConstraint("field IN ('revenue','profit_after_tax','ebit','interest_expense','current_assets','current_liabilities','total_assets','total_liabilities','total_equity','short_term_borrowings','long_term_borrowings','current_maturities')", name='figure_field'),
    sa.CheckConstraint("origin = 'manual'", name='figure_origin'),
    sa.CheckConstraint('NOT reviewed OR normalized_inr IS NOT NULL', name='figure_review'),
    sa.CheckConstraint('revision > 0', name='figure_revision'),
    sa.ForeignKeyConstraint(['period_id'], ['periods.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('period_id', 'field')
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_table('figures')
    op.drop_table('periods')
    op.drop_index(op.f('ix_analysis_runs_business_id'), table_name='analysis_runs')
    op.drop_table('analysis_runs')
    op.drop_index(op.f('ix_businesses_owner_id'), table_name='businesses')
    op.drop_table('businesses')
    op.drop_table('owners')
