"""add documents table

Revision ID: d842f19b6e03
Revises: c491e82a10bf
Create Date: 2026-11-17 20:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd842f19b6e03'
down_revision: Union[str, Sequence[str], None] = 'c491e82a10bf'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'documents',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('business_id', sa.Uuid(), nullable=False),
        sa.Column('owner_id', sa.Uuid(), nullable=False),
        sa.Column('filename', sa.String(length=255), nullable=False),
        sa.Column('sha256', sa.String(length=64), nullable=False),
        sa.Column('byte_size', sa.Integer(), nullable=False),
        sa.Column('page_count', sa.Integer(), nullable=True),
        sa.Column('extracted_char_count', sa.Integer(), nullable=True),
        sa.Column('status', sa.String(length=20), nullable=False),
        sa.Column('error_code', sa.String(length=64), nullable=True),
        sa.Column('error_message', sa.Text(), nullable=True),
        sa.Column(
            'created_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.Column(
            'updated_at',
            sa.DateTime(timezone=True),
            server_default=sa.text('now()'),
            nullable=False,
        ),
        sa.CheckConstraint(
            "length(btrim(filename)) > 0 AND lower(filename) LIKE '%.pdf'",
            name='document_filename',
        ),
        sa.CheckConstraint('length(sha256) = 64', name='document_sha256'),
        sa.CheckConstraint(
            'byte_size BETWEEN 1 AND 20971520',
            name='document_byte_size',
        ),
        sa.CheckConstraint(
            'page_count IS NULL OR page_count BETWEEN 1 AND 50',
            name='document_page_count',
        ),
        sa.CheckConstraint(
            'extracted_char_count IS NULL OR extracted_char_count >= 0',
            name='document_extracted_chars',
        ),
        sa.CheckConstraint(
            "status IN ('processing', 'ready', 'failed')",
            name='document_status',
        ),
        sa.CheckConstraint(
            "(status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) "
            "OR (status IN ('processing', 'ready') AND error_code IS NULL AND error_message IS NULL)",
            name='document_status_error',
        ),
        sa.CheckConstraint(
            "status != 'ready' OR (page_count BETWEEN 1 AND 50 AND extracted_char_count > 0)",
            name='document_ready_stats',
        ),
        sa.ForeignKeyConstraint(
            ['business_id'],
            ['businesses.id'],
            ondelete='CASCADE',
        ),
        sa.ForeignKeyConstraint(
            ['owner_id'],
            ['owners.id'],
            ondelete='CASCADE',
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        op.f('ix_documents_business_id'),
        'documents',
        ['business_id'],
        unique=False,
    )
    op.create_index(
        op.f('ix_documents_owner_id'),
        'documents',
        ['owner_id'],
        unique=False,
    )
    op.create_index(
        'documents_one_active_job_idx',
        'documents',
        ['owner_id'],
        unique=True,
        postgresql_where=sa.text("status = 'processing'"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(
        'documents_one_active_job_idx',
        table_name='documents',
        postgresql_where=sa.text("status = 'processing'"),
    )
    op.drop_index(op.f('ix_documents_owner_id'), table_name='documents')
    op.drop_index(op.f('ix_documents_business_id'), table_name='documents')
    op.drop_table('documents')
