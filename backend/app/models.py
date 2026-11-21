from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    MetaData,
    Numeric,
    String,
    Table,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB

metadata = MetaData()


def created_at():
    return Column(
        "created_at", DateTime(timezone=True), nullable=False, server_default=func.now()
    )


owners = Table("owners", metadata, Column("id", Uuid, primary_key=True), created_at())
accounts = Table(
    "accounts",
    metadata,
    Column(
        "owner_id", Uuid, ForeignKey("owners.id", ondelete="CASCADE"), primary_key=True
    ),
    Column("email", String(254), nullable=False, unique=True),
    Column("password_hash", Text, nullable=False),
    created_at(),
    CheckConstraint(
        "email = lower(btrim(email)) AND position('@' in email) > 1",
        name="account_email",
    ),
    CheckConstraint("password_hash LIKE 'scrypt$%'", name="account_password_hash"),
)
sessions = Table(
    "sessions",
    metadata,
    Column("token_hash", String(64), primary_key=True),
    Column(
        "owner_id",
        Uuid,
        ForeignKey("owners.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("expires_at", DateTime(timezone=True), nullable=False),
    created_at(),
    CheckConstraint("length(token_hash) = 64", name="session_token_hash"),
)
businesses = Table(
    "businesses",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column("owner_id", Uuid, ForeignKey("owners.id"), nullable=False, index=True),
    Column("name", String(120), nullable=False),
    Column("currency", String(3), nullable=False),
    Column("basis", String(20), nullable=False),
    Column("input_revision", Integer, nullable=False),
    created_at(),
    CheckConstraint("currency = 'INR' AND basis = 'standalone'", name="business_basis"),
    CheckConstraint("input_revision > 0", name="business_revision"),
)
periods = Table(
    "periods",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "business_id",
        Uuid,
        ForeignKey("businesses.id", ondelete="CASCADE"),
        nullable=False,
    ),
    Column("year_start", Integer, nullable=False),
    Column("unit", String(20), nullable=False),
    Column("multiplier", Integer, nullable=False),
    Column("comparable_to_prior", Boolean, nullable=False),
    UniqueConstraint("business_id", "year_start", name="period_business_year"),
    CheckConstraint("year_start BETWEEN 1 AND 9998", name="period_year"),
    CheckConstraint(
        "(unit = 'rupees' AND multiplier = 1) OR (unit = 'thousands' AND multiplier = 1000) OR (unit = 'lakhs' AND multiplier = 100000) OR (unit = 'crores' AND multiplier = 10000000)",
        name="period_unit",
    ),
)
figures = Table(
    "figures",
    metadata,
    Column(
        "period_id",
        Uuid,
        ForeignKey("periods.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("field", String(40), primary_key=True),
    Column("raw", String(64)),
    Column("normalized_inr", Numeric),
    Column("origin", String(20), nullable=False),
    Column(
        "source_document_id",
        Uuid,
        ForeignKey("documents.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    ),
    Column("source_meta", JSONB(none_as_null=True), nullable=True),
    Column("reviewed", Boolean, nullable=False),
    Column("reviewed_by", Uuid, ForeignKey("owners.id")),
    Column("revision", Integer, nullable=False),
    CheckConstraint("revision > 0", name="figure_revision"),
    CheckConstraint("origin IN ('manual', 'document')", name="figure_origin"),
    CheckConstraint(
        "(origin = 'manual' AND source_document_id IS NULL AND source_meta IS NULL) "
        "OR (origin = 'document' AND normalized_inr IS NOT NULL AND source_meta IS NOT NULL)",
        name="figure_source",
    ),
    CheckConstraint("NOT reviewed OR normalized_inr IS NOT NULL", name="figure_review"),
    CheckConstraint("reviewed = (reviewed_by IS NOT NULL)", name="figure_reviewer"),
    CheckConstraint(
        "field IN ('revenue','profit_after_tax','ebit','interest_expense','current_assets','current_liabilities','total_assets','total_liabilities','total_equity','short_term_borrowings','long_term_borrowings','current_maturities')",
        name="figure_field",
    ),
)
revisions = Table(
    "revisions",
    metadata,
    Column(
        "business_id",
        Uuid,
        ForeignKey("businesses.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column("input_revision", Integer, primary_key=True),
    Column("actor_id", Uuid, ForeignKey("owners.id"), nullable=False),
    Column("inputs", JSONB, nullable=False),
    created_at(),
    CheckConstraint("input_revision > 0", name="revision_number"),
)
analysis_runs = Table(
    "analysis_runs",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "business_id",
        Uuid,
        ForeignKey("businesses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("input_revision", Integer, nullable=False),
    Column("rule_version", Text, nullable=False),
    Column("inputs", JSONB, nullable=False),
    Column("results", JSONB, nullable=False),
    created_at(),
    CheckConstraint("input_revision > 0", name="run_revision"),
)
documents = Table(
    "documents",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "business_id",
        Uuid,
        ForeignKey("businesses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "owner_id",
        Uuid,
        ForeignKey("owners.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("filename", String(255), nullable=False),
    Column("sha256", String(64), nullable=False),
    Column("byte_size", Integer, nullable=False),
    Column("page_count", Integer),
    Column("extracted_char_count", Integer),
    Column("extraction", JSONB),
    Column("status", String(20), nullable=False),
    Column("error_code", String(64)),
    Column("error_message", Text),
    created_at(),
    Column(
        "updated_at",
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    ),
    CheckConstraint(
        "length(btrim(filename)) > 0 AND lower(filename) LIKE '%.pdf'",
        name="document_filename",
    ),
    CheckConstraint("length(sha256) = 64", name="document_sha256"),
    CheckConstraint(
        "byte_size BETWEEN 1 AND 20971520",
        name="document_byte_size",
    ),
    CheckConstraint(
        "page_count IS NULL OR page_count BETWEEN 1 AND 50",
        name="document_page_count",
    ),
    CheckConstraint(
        "extracted_char_count IS NULL OR extracted_char_count >= 0",
        name="document_extracted_chars",
    ),
    CheckConstraint(
        "status IN ('processing', 'ready', 'failed')",
        name="document_status",
    ),
    CheckConstraint(
        "(status = 'failed' AND error_code IS NOT NULL AND error_message IS NOT NULL) "
        "OR (status IN ('processing', 'ready') AND error_code IS NULL AND error_message IS NULL)",
        name="document_status_error",
    ),
    CheckConstraint(
        "status != 'ready' OR (page_count BETWEEN 1 AND 50 AND extracted_char_count > 0)",
        name="document_ready_stats",
    ),
)
Index(
    "documents_one_active_job_idx",
    documents.c.owner_id,
    unique=True,
    postgresql_where=text("status = 'processing'"),
)
document_chunks = Table(
    "document_chunks",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "document_id",
        Uuid,
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "business_id",
        Uuid,
        ForeignKey("businesses.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column(
        "owner_id",
        Uuid,
        ForeignKey("owners.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("chunk_index", Integer, nullable=False),
    Column("page_number", Integer, nullable=False),
    Column("section", String(255), nullable=True),
    Column("period_years", JSONB, nullable=False),
    Column("content", Text, nullable=False),
    Column("token_count", Integer, nullable=False),
    Column("embedding_model", String(120), nullable=False),
    Column("embedding", Vector(384), nullable=False),
    created_at(),
    UniqueConstraint("document_id", "chunk_index", name="chunk_document_index"),
    CheckConstraint("chunk_index >= 0", name="chunk_index_non_negative"),
    CheckConstraint("page_number BETWEEN 1 AND 50", name="chunk_page_number"),
    CheckConstraint("length(btrim(content)) > 0", name="chunk_content_non_empty"),
    CheckConstraint("token_count BETWEEN 1 AND 256", name="chunk_token_count"),
)
Index(
    "ix_document_chunks_owner_business",
    document_chunks.c.owner_id,
    document_chunks.c.business_id,
)
audit_events = Table(
    "audit_events",
    metadata,
    Column("id", Uuid, primary_key=True),
    Column(
        "owner_id",
        Uuid,
        ForeignKey("owners.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    ),
    Column("action", String(64), nullable=False),
    Column("resource_type", String(32), nullable=False),
    Column("resource_id", Uuid, nullable=True),
    Column("business_id", Uuid, nullable=True, index=True),
    Column("details", JSONB(none_as_null=True), nullable=True),
    created_at(),
    CheckConstraint(
        "action IN ('account_registered','session_login','session_logout','workspace_created','workspace_updated','workspace_deleted','analysis_run_created','document_uploaded','document_retried','document_extracted','document_deleted','report_generated','qa_asked')",
        name="audit_action",
    ),
    CheckConstraint(
        "resource_type IN ('account','session','workspace','analysis_run','document','report','qa')",
        name="audit_resource_type",
    ),
)
Index(
    "ix_audit_events_owner_created",
    audit_events.c.owner_id,
    audit_events.c.created_at,
)
