import json
from decimal import Context, localcontext
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.engine import Connection

from app.analysis import MULTIPLIERS, analyse
from app.models import businesses, periods, figures, revisions, analysis_runs
from app.schemas import AnalysisRequest, AnalysisResponse, AnalysisRunSummary, BusinessSummary, WorkspaceResponse


def owned_business(connection: Connection, owner_id: UUID, business_id: UUID, for_update: bool = False):
    stmt = select(businesses).where(businesses.c.id == business_id, businesses.c.owner_id == owner_id)
    if for_update:
        stmt = stmt.with_for_update()
    row = connection.execute(stmt).mappings().one_or_none()
    if row is None:
        raise LookupError("Business not found")
    return row


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
        multiplier = MULTIPLIERS[period.unit]
        connection.execute(periods.insert().values(
            id=period_id, business_id=business_id, year_start=period.year_start,
            unit=period.unit, multiplier=multiplier, comparable_to_prior=period.comparable_to_prior,
        ))
        prev_period = prior_periods.get(period.year_start) if prior_periods is not None else None
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
                    )
                    fig_revision = prev_fig.revision + (1 if changed else 0)
                elif max_revisions and (period.year_start, field) in max_revisions:
                    fig_revision = max_revisions[(period.year_start, field)] + 1
                else:
                    fig_revision = 1
                rows.append(dict(
                    period_id=period_id, field=field, raw=figure.raw,
                    normalized_inr=None if figure.amount is None else figure.amount * multiplier,
                    origin=figure.origin, reviewed=figure.reviewed,
                    reviewed_by=owner_id if figure.reviewed else None,
                    revision=fig_revision,
                ))
        if rows:
            connection.execute(figures.insert(), rows)


def save_business(connection: Connection, owner_id: UUID, request: AnalysisRequest) -> UUID:
    business_id = uuid4()
    connection.execute(businesses.insert().values(
        id=business_id, owner_id=owner_id, name=request.business_name,
        currency=request.currency, basis=request.basis, input_revision=1,
    ))
    _insert_periods(connection, owner_id, business_id, request)
    saved = load_business(connection, owner_id, business_id)
    connection.execute(revisions.insert().values(
        business_id=business_id, input_revision=1, actor_id=owner_id,
        inputs=saved.model_dump(mode="json"),
    ))
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
        raise ValueError("Workspace has been updated in another session; reload before saving")
    prior = load_business(connection, owner_id, business_id)
    prior_periods = {period.year_start: period for period in prior.periods}
    max_revisions: dict[tuple[int, str], int] = {}
    for snapshot in connection.execute(
        select(revisions.c.inputs).where(revisions.c.business_id == business_id).order_by(revisions.c.input_revision)
    ).scalars():
        for period in snapshot.get("periods", []):
            year = period.get("year_start")
            for field, fig in period.get("values", {}).items():
                key = (year, field)
                max_revisions[key] = max(max_revisions.get(key, 0), int(fig.get("revision", 1)))
    next_revision = business["input_revision"] + 1
    connection.execute(
        businesses.update()
        .where(businesses.c.id == business_id)
        .values(
            name=request.business_name, currency=request.currency,
            basis=request.basis, input_revision=next_revision,
        )
    )
    connection.execute(periods.delete().where(periods.c.business_id == business_id))
    _insert_periods(connection, owner_id, business_id, request, prior_periods, max_revisions)
    saved = load_business(connection, owner_id, business_id)
    connection.execute(revisions.insert().values(
        business_id=business_id, input_revision=next_revision, actor_id=owner_id,
        inputs=saved.model_dump(mode="json"),
    ))
    return next_revision


def load_business(connection: Connection, owner_id: UUID, business_id: UUID) -> AnalysisRequest:
    business = owned_business(connection, owner_id, business_id)
    saved_periods = []
    for period in connection.execute(select(periods).where(periods.c.business_id == business_id)
                                     .order_by(periods.c.year_start)).mappings():
        values = {row["field"]: {key: row[key] for key in ("raw", "origin", "reviewed", "revision")}
                  for row in connection.execute(select(figures).where(figures.c.period_id == period["id"])).mappings()}
        saved_periods.append(dict(year_start=period["year_start"], unit=period["unit"],
            comparable_to_prior=period["comparable_to_prior"], values=values))
    return AnalysisRequest(business_name=business["name"], currency=business["currency"],
                           basis=business["basis"], periods=saved_periods)


def save_analysis(connection: Connection, owner_id: UUID, business_id: UUID) -> UUID:
    business = owned_business(connection, owner_id, business_id)
    request = load_business(connection, owner_id, business_id)
    result = analyse(request)
    run_id = uuid4()
    connection.execute(analysis_runs.insert().values(id=run_id, business_id=business_id,
        input_revision=business["input_revision"], rule_version=result.rule_version,
        inputs=request.model_dump(mode="json"), results=result.model_dump(mode="json")))
    return run_id


def load_analysis(connection: Connection, owner_id: UUID, run_id: UUID) -> AnalysisResponse:
    row = connection.execute(select(analysis_runs.c.results).join(businesses)
        .where(analysis_runs.c.id == run_id, businesses.c.owner_id == owner_id)).one_or_none()
    if row is None:
        raise LookupError("Analysis not found")
    return AnalysisResponse.model_validate_json(json.dumps(row.results))


def list_businesses(connection: Connection, owner_id: UUID) -> list[BusinessSummary]:
    rows = connection.execute(
        select(businesses).where(businesses.c.owner_id == owner_id)
        .order_by(businesses.c.created_at.desc(), businesses.c.id)
    ).mappings()
    return [BusinessSummary(id=row["id"], business_name=row["name"], input_revision=row["input_revision"]) for row in rows]


def load_workspace(connection: Connection, owner_id: UUID, business_id: UUID) -> WorkspaceResponse:
    business = owned_business(connection, owner_id, business_id)
    request = load_business(connection, owner_id, business_id)
    run_rows = connection.execute(
        select(
            analysis_runs.c.id,
            analysis_runs.c.input_revision,
            analysis_runs.c.rule_version,
            analysis_runs.c.results,
            analysis_runs.c.created_at,
        )
        .where(analysis_runs.c.business_id == business_id)
        .order_by(
            analysis_runs.c.input_revision.desc(),
            analysis_runs.c.created_at.desc(),
            analysis_runs.c.id.desc(),
        )
    ).mappings().all()
    current_run = (
        run_rows[0]
        if run_rows and run_rows[0]["input_revision"] == business["input_revision"]
        else None
    )
    latest = AnalysisResponse.model_validate_json(json.dumps(current_run["results"])) if current_run else None
    runs = [
        AnalysisRunSummary(
            run_id=row["id"],
            input_revision=row["input_revision"],
            rule_version=row["rule_version"],
            action_version=row["results"].get("action_version") if isinstance(row["results"], dict) else None,
            superseded=not (index == 0 and row["input_revision"] == business["input_revision"]),
            created_at=row["created_at"],
        )
        for index, row in enumerate(run_rows)
    ]
    return WorkspaceResponse(
        business_id=business_id, input_revision=business["input_revision"],
        request=request, latest_run_id=current_run["id"] if current_run else None,
        latest_analysis=latest, runs=runs,
    )
