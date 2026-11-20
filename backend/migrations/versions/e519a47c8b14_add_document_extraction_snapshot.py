"""add document extraction snapshot

Revision ID: e519a47c8b14
Revises: d842f19b6e03
Create Date: 2026-11-19 23:52:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'e519a47c8b14'
down_revision: Union[str, Sequence[str], None] = 'd842f19b6e03'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        'documents',
        sa.Column('extraction', postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('documents', 'extraction')
