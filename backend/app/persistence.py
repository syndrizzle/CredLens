from decimal import Context, localcontext
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.engine import Connection

from app.analysis import analyse
from app.analysis_runs import RunHistory, load_run_history, load_run_payload, parse_analysis
from app.audit import record_audit_event
from app.documents import list_documents
from app.models import analysis_runs, businesses, documents, figures, periods, revisions
from app.schemas.documents import DocumentExtractionSnapshot
from app.schemas.financial import AnalysisRequest, AnalysisResponse, UNIT_MULTIPLIERS
from app.schemas.workspaces import (
    BusinessSummary,
    WorkspaceResponse,
)
from app.workspace_access import document_scope, owned_business


class InvalidFigureSourceError(Exception):
    pass


def _validate_document_sources(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    request: AnalysisRequest,
    prior_periods: dict | None = None,
) -> None:
    doc_figures = [
        (period, field, figure)
        for period in request.periods
        for field, figure in period.values.items()
        if figure.origin == "document"
    ]
    if not doc_figures:
        return
    doc_ids = {
        figure.source.document_id
        for _, _, figure in doc_figures
        if figure.source is not None and figure.source.document_id is not None
    }
    ready_docs: dict[UUID, tuple[str, set[tuple]]] = {}
    if doc_ids:
        rows = (
            connection.execute(
                select(documents.c.id, documents.c.filename, documents.c.extraction)
                .where(
                    documents.c.id.in_(doc_ids),
                    *document_scope(owner_id, business_id),
                    documents.c.status == "ready",
                )
                .with_for_update(read=True, key_share=True)
            )
            .mappings()
            .all()
        )
        for row in rows:
            raw_extraction = row["extraction"]
            if not isinstance(raw_extraction, dict):
                continue
            try:
                snapshot = DocumentExtractionSnapshot.model_validate(raw_extraction)
            except Exception:
                continue
            candidates = {
                (
                    c.field,
                    c.year_start,
                    c.unit,
                    c.page_number,
                    c.table_index,
                    c.row_index,
                    c.column_index,
                    c.label,
                    c.raw,
                    c.amount,
                )
                for c in snapshot.candidates
                if not c.issues and c.normalized_inr is not None
            }
            ready_docs[row["id"]] = (row["filename"], candidates)
    for period, field, figure in doc_figures:
        src = figure.source
        assert src is not None
        if src.document_id is None:
            prev_period = (
                prior_periods.get(period.year_start) if prior_periods else None
            )
            prev_fig = prev_period.values.get(field) if prev_period else None
            if (
                prev_period is None
                or prev_fig is None
                or prev_fig.origin != "document"
                or prev_fig.source != src
                or prev_period.unit != period.unit
                or prev_fig.amount != figure.amount
            ):
                raise InvalidFigureSourceError(
                    "Detached document reference can only be preserved unchanged from the saved workspace; edit the figure as manual instead."
                )
            continue
        doc = ready_docs.get(src.document_id)
        key = (
            field,
            period.year_start,
            period.unit,
            src.page_number,
            src.table_index,
            src.row_index,
            src.column_index,
            src.label,
            src.raw_token,
            figure.amount,
        )
        if doc is None or src.filename != doc[0] or key not in doc[1]:
            raise InvalidFigureSourceError(
                "Referenced source document is unavailable or does not match an extracted candidate for this business."
            )


def _insert_periods(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    request: AnalysisRequest,
    prior_periods: dict | None = None,
    max_revisions: dict[tuple[int, str], int] | None = None,
) -> None:
    for period in request.periods:
        period_id = uuid4()
        multiplier = UNIT_MULTIPLIERS[period.unit]
        connection.execute(
            periods.insert().values(
                id=period_id,
                business_id=business_id,
                year_start=period.year_start,
                unit=period.unit,
                multiplier=multiplier,
                comparable_to_prior=period.comparable_to_prior,
            )
        )
        prev_period = (
            prior_periods.get(period.year_start) if prior_periods is not None else None
        )
        with localcontext(Context(prec=34)):
            rows = []
            for field, figure in period.values.items():
                if prior_periods is None:
                    fig_revision = figure.revision
                elif prev_period is not None and field in prev_period.values:
                    prev_fig = prev_period.values[field]
                    curr_raw = (figure.raw or "").strip()
                    prev_raw = (prev_fig.raw or "").strip()
                    changed = (
                        curr_raw != prev_raw
                        or (curr_raw != "" and period.unit != prev_period.unit)
                        or figure.origin != prev_fig.origin
                        or figure.source != prev_fig.source
                    )
                    base_rev = max(
                        prev_fig.revision,
                        (max_revisions or {}).get((period.year_start, field), 0),
                    )
                    fig_revision = base_rev + (1 if changed else 0)
                elif max_revisions and (period.year_start, field) in max_revisions:
                    fig_revision = max_revisions[(period.year_start, field)] + 1
                else:
                    fig_revision = 1
                rows.append(
                    dict(
                        period_id=period_id,
                        field=field,
                        raw=figure.raw,
                        normalized_inr=None
                        if figure.amount is None
                        else figure.amount * multiplier,
                        origin=figure.origin,
                        source_document_id=figure.source.document_id
                        if figure.source is not None
                        else None,
                        source_meta=figure.source.model_dump(
                            mode="json", exclude={"document_id"}
                        )
                        if figure.source is not None
                        else None,
                        reviewed=figure.reviewed,
                        reviewed_by=owner_id if figure.reviewed else None,
                        revision=fig_revision,
                    )
                )
        if rows:
            connection.execute(figures.insert(), rows)


def _load_business_with_revision(
    connection: Connection, owner_id: UUID, business_id: UUID, for_update: bool = False
) -> tuple[int, AnalysisRequest]:
    if for_update:
        owned_business(connection, owner_id, business_id, for_update=True)
    rows = connection.execute(
        select(
            businesses.c.input_revision,
            businesses.c.name,
            businesses.c.currency,
            businesses.c.basis,
            periods.c.year_start,
            periods.c.unit,
            periods.c.comparable_to_prior,
            figures.c.field,
            figures.c.raw,
            figures.c.origin,
            figures.c.reviewed,
            figures.c.revision,
            figures.c.source_meta,
            figures.c.source_document_id,
        )
        .select_from(businesses.outerjoin(periods).outerjoin(figures))
        .where(businesses.c.id == business_id, businesses.c.owner_id == owner_id)
        .order_by(periods.c.year_start)
    ).mappings().all()
    if not rows:
        raise LookupError("Business not found")
    first = rows[0]
    saved_periods = {}
    for row in rows:
        year = row["year_start"]
        if year is None:
            continue
        period = saved_periods.setdefault(year, {
            "year_start": year, "unit": row["unit"],
            "comparable_to_prior": row["comparable_to_prior"], "values": {},
        })
        if row["field"] is not None:
            figure = {key: row[key] for key in ("raw", "origin", "reviewed", "revision")}
            if row["origin"] == "document" and row["source_meta"] is not None:
                figure["source"] = {"document_id": row["source_document_id"], **row["source_meta"]}
            period["values"][row["field"]] = figure
    return first["input_revision"], AnalysisRequest(
        business_name=first["name"], currency=first["currency"],
        basis=first["basis"], periods=list(saved_periods.values()),
    )


def save_business(
    connection: Connection, owner_id: UUID, request: AnalysisRequest
) -> UUID:
    business_id = uuid4()
    _validate_document_sources(connection, owner_id, business_id, request)
    connection.execute(
        businesses.insert().values(
            id=business_id,
            owner_id=owner_id,
            name=request.business_name,
            currency=request.currency,
            basis=request.basis,
            input_revision=1,
        )
    )
    _insert_periods(connection, owner_id, business_id, request)
    _, saved = _load_business_with_revision(
        connection, owner_id, business_id
    )
    connection.execute(
        revisions.insert().values(
            business_id=business_id,
            input_revision=1,
            actor_id=owner_id,
            inputs=saved.model_dump(mode="json"),
        )
    )
    record_audit_event(
        connection,
        owner_id,
        "workspace_created",
        resource_id=business_id,
        business_id=business_id,
        details={"input_revision": 1},
    )
    return business_id


def update_business(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    request: AnalysisRequest,
    expected_revision: int,
) -> int:
    business = owned_business(connection, owner_id, business_id, for_update=True)
    if business["input_revision"] != expected_revision:
        raise ValueError(
            "Workspace has been updated in another session; reload before saving"
        )
    _, prior = _load_business_with_revision(
        connection, owner_id, business_id
    )
    connection.execute(
        pg_insert(revisions)
        .values(
            business_id=business_id,
            input_revision=business["input_revision"],
            actor_id=owner_id,
            inputs=prior.model_dump(mode="json"),
        )
        .on_conflict_do_nothing(
            index_elements=[revisions.c.business_id, revisions.c.input_revision]
        )
    )
    prior_periods = {period.year_start: period for period in prior.periods}
    _validate_document_sources(
        connection, owner_id, business_id, request, prior_periods=prior_periods
    )
    max_revisions: dict[tuple[int, str], int] = {}
    for period in prior.periods:
        for field, fig in period.values.items():
            key = (period.year_start, field)
            max_revisions[key] = max(max_revisions.get(key, 0), fig.revision)
    for snapshot in connection.execute(
        select(revisions.c.inputs)
        .where(revisions.c.business_id == business_id)
        .order_by(revisions.c.input_revision)
    ).scalars():
        for period in snapshot.get("periods", []):
            year = period.get("year_start")
            for field, fig in period.get("values", {}).items():
                key = (year, field)
                max_revisions[key] = max(
                    max_revisions.get(key, 0), int(fig.get("revision", 1))
                )
    next_revision = business["input_revision"] + 1
    connection.execute(
        businesses.update()
        .where(businesses.c.id == business_id)
        .values(
            name=request.business_name,
            currency=request.currency,
            basis=request.basis,
            input_revision=next_revision,
        )
    )
    connection.execute(periods.delete().where(periods.c.business_id == business_id))
    _insert_periods(
        connection, owner_id, business_id, request, prior_periods, max_revisions
    )
    _, saved = _load_business_with_revision(
        connection, owner_id, business_id
    )
    connection.execute(
        revisions.insert().values(
            business_id=business_id,
            input_revision=next_revision,
            actor_id=owner_id,
            inputs=saved.model_dump(mode="json"),
        )
    )
    record_audit_event(
        connection,
        owner_id,
        "workspace_updated",
        resource_id=business_id,
        business_id=business_id,
        details={"input_revision": next_revision},
    )
    return next_revision


def load_business(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> AnalysisRequest:
    return _load_business_with_revision(connection, owner_id, business_id)[1]


def save_analysis(connection: Connection, owner_id: UUID, business_id: UUID) -> UUID:
    input_revision, request = _load_business_with_revision(
        connection, owner_id, business_id, for_update=True
    )
    result = analyse(request)
    run_id = uuid4()
    connection.execute(
        analysis_runs.insert().values(
            id=run_id,
            business_id=business_id,
            input_revision=input_revision,
            rule_version=result.rule_version,
            inputs=request.model_dump(mode="json"),
            results=result.model_dump(mode="json"),
        )
    )
    record_audit_event(
        connection,
        owner_id,
        "analysis_run_created",
        resource_id=run_id,
        business_id=business_id,
        details={"input_revision": input_revision},
    )
    return run_id


def list_businesses(connection: Connection, owner_id: UUID) -> list[BusinessSummary]:
    rows = connection.execute(
        select(businesses)
        .where(businesses.c.owner_id == owner_id)
        .order_by(businesses.c.created_at.desc(), businesses.c.id)
    ).mappings()
    return [
        BusinessSummary(
            id=row["id"],
            business_name=row["name"],
            input_revision=row["input_revision"],
        )
        for row in rows
    ]


def load_workspace_analysis(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> tuple[AnalysisRequest, RunHistory, AnalysisResponse | None]:
    # Keep the input and history snapshots on the same revision under READ COMMITTED.
    while True:
        revision, request = _load_business_with_revision(connection, owner_id, business_id)
        history = load_run_history(connection, owner_id, business_id)
        if history.revision == revision:
            break
    current_id = history.current_id
    latest = (
        parse_analysis(load_run_payload(connection, owner_id, business_id, current_id)["results"])
        if current_id is not None else None
    )
    return request, history, latest


def load_workspace(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> WorkspaceResponse:
    request, history, latest = load_workspace_analysis(connection, owner_id, business_id)
    return WorkspaceResponse(
        business_id=business_id,
        input_revision=history.revision,
        request=request,
        latest_run_id=history.current_id,
        latest_analysis=latest,
        runs=history.summaries(),
        documents=list_documents(connection, owner_id, business_id),
    )
