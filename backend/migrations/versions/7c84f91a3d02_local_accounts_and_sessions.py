"""local accounts and sessions

Revision ID: 7c84f91a3d02
Revises: 2b45e0cd055f
Create Date: 2026-11-12 15:15:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7c84f91a3d02'
down_revision: Union[str, Sequence[str], None] = '2b45e0cd055f'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('accounts',
    sa.Column('owner_id', sa.Uuid(), nullable=False),
    sa.Column('email', sa.String(length=254), nullable=False),
    sa.Column('password_hash', sa.Text(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint("email = lower(btrim(email)) AND position('@' in email) > 1", name='account_email'),
    sa.CheckConstraint("password_hash LIKE 'scrypt$%'", name='account_password_hash'),
    sa.ForeignKeyConstraint(['owner_id'], ['owners.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('owner_id'),
    sa.UniqueConstraint('email')
    )
    op.create_table('sessions',
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('owner_id', sa.Uuid(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.CheckConstraint('length(token_hash) = 64', name='session_token_hash'),
    sa.ForeignKeyConstraint(['owner_id'], ['owners.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('token_hash')
    )
    op.create_index(op.f('ix_sessions_owner_id'), 'sessions', ['owner_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_sessions_owner_id'), table_name='sessions')
    op.drop_table('sessions')
    op.drop_table('accounts')
