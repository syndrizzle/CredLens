import json
from decimal import Context, localcontext
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.engine import Connection

from app.analysis import MULTIPLIERS, analyse
from app.models import businesses, periods, figures, analysis_runs
from app.schemas import AnalysisRequest, AnalysisResponse, BusinessSummary, WorkspaceResponse


def owned_business(connection: Connection, owner_id: UUID, business_id: UUID):
    row = connection.execute(select(businesses).where(
        businesses.c.id == business_id, businesses.c.owner_id == owner_id)).mappings().one_or_none()
    if row is None:
        raise LookupError("Business not found")
    return row


def save_business(connection: Connection, owner_id: UUID, request: AnalysisRequest) -> UUID:
    business_id = uuid4()
    connection.execute(businesses.insert().values(id=business_id, owner_id=owner_id,
        name=request.business_name, currency=request.currency, basis=request.basis, input_revision=1))
    for period in request.periods:
        period_id = uuid4()
        multiplier = MULTIPLIERS[period.unit]
        connection.execute(periods.insert().values(id=period_id, business_id=business_id,
            year_start=period.year_start, unit=period.unit, multiplier=multiplier,
            comparable_to_prior=period.comparable_to_prior))
        with localcontext(Context(prec=34)):
            rows = [dict(period_id=period_id, field=field, raw=figure.raw,
                         normalized_inr=None if figure.amount is None else figure.amount * multiplier,
                         origin=figure.origin, reviewed=figure.reviewed, revision=figure.revision)
                    for field, figure in period.values.items()]
        if rows:
            connection.execute(figures.insert(), rows)
    return business_id


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
    run = connection.execute(
        select(analysis_runs.c.id, analysis_runs.c.results)
        .where(analysis_runs.c.business_id == business_id)
        .order_by(analysis_runs.c.created_at.desc(), analysis_runs.c.id.desc())
        .limit(1)
    ).mappings().one_or_none()
    latest = AnalysisResponse.model_validate_json(json.dumps(run["results"])) if run else None
    return WorkspaceResponse(
        business_id=business_id, input_revision=business["input_revision"],
        request=request, latest_run_id=run["id"] if run else None, latest_analysis=latest,
    )
