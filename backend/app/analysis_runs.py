"""Read immutable analysis snapshots and their version history."""

import json
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import Connection, RowMapping

from app.models import analysis_runs, businesses
from app.schemas.financial import AnalysisResponse
from app.schemas.workspaces import AnalysisRunResponse, AnalysisRunSummary

RUN_ORDER = (
    analysis_runs.c.input_revision.desc(),
    analysis_runs.c.created_at.desc(),
    analysis_runs.c.id.desc(),
)
RUN_METADATA = (
    analysis_runs.c.id,
    analysis_runs.c.business_id,
    analysis_runs.c.input_revision,
    analysis_runs.c.rule_version,
    analysis_runs.c.created_at,
    analysis_runs.c.results["action_version"].astext.label("action_version"),
)


def parse_analysis(results: dict) -> AnalysisResponse:
    return AnalysisResponse.model_validate_json(json.dumps(results))


@dataclass(frozen=True)
class RunHistory:
    revision: int
    runs: list[RowMapping]

    @property
    def current_id(self) -> UUID | None:
        if self.runs and self.runs[0]["input_revision"] == self.revision:
            return self.runs[0]["id"]
        return None

    def summaries(self) -> list[AnalysisRunSummary]:
        current_id = self.current_id
        return [
            AnalysisRunSummary(
                run_id=row["id"],
                input_revision=row["input_revision"],
                rule_version=row["rule_version"],
                action_version=row["action_version"],
                superseded=row["id"] != current_id,
                created_at=row["created_at"],
            )
            for row in self.runs
        ]


def load_run_history(connection: Connection, owner_id: UUID, business_id: UUID) -> RunHistory:
    rows = connection.execute(
        select(businesses.c.input_revision.label("workspace_revision"), *RUN_METADATA)
        .select_from(businesses.outerjoin(analysis_runs))
        .where(businesses.c.id == business_id, businesses.c.owner_id == owner_id)
        .order_by(*RUN_ORDER)
    ).mappings().all()
    if not rows:
        raise LookupError("Business not found")
    return RunHistory(rows[0]["workspace_revision"], [row for row in rows if row["id"] is not None])


def load_run_payload(
    connection: Connection, owner_id: UUID, business_id: UUID, run_id: UUID, *, include_inputs: bool = False
) -> RowMapping:
    columns = (analysis_runs.c.inputs, analysis_runs.c.results) if include_inputs else (analysis_runs.c.results,)
    row = connection.execute(
        select(*columns).join(businesses, analysis_runs.c.business_id == businesses.c.id).where(
            businesses.c.owner_id == owner_id, businesses.c.id == business_id, analysis_runs.c.id == run_id,
        )
    ).mappings().one_or_none()
    if row is None:
        raise LookupError("Business not found")
    return row


def load_analysis(connection: Connection, owner_id: UUID, run_id: UUID) -> AnalysisRunResponse:
    latest_run_id = (
        select(analysis_runs.c.id)
        .where(analysis_runs.c.business_id == businesses.c.id)
        .correlate(businesses)
        .order_by(*RUN_ORDER)
        .limit(1)
        .scalar_subquery()
    )
    row = connection.execute(
        select(
            analysis_runs.c.id,
            analysis_runs.c.business_id,
            analysis_runs.c.input_revision,
            analysis_runs.c.results,
            analysis_runs.c.created_at,
            businesses.c.input_revision.label("workspace_revision"),
            latest_run_id.label("latest_run_id"),
        )
        .join(businesses, analysis_runs.c.business_id == businesses.c.id)
        .where(analysis_runs.c.id == run_id, businesses.c.owner_id == owner_id)
    ).mappings().one_or_none()
    if row is None:
        raise LookupError("Analysis not found")
    return AnalysisRunResponse(
        **parse_analysis(row["results"]).model_dump(),
        run_id=row["id"],
        business_id=row["business_id"],
        input_revision=row["input_revision"],
        superseded=not (
            row["input_revision"] == row["workspace_revision"] and row["id"] == row["latest_run_id"]
        ),
        created_at=row["created_at"],
    )
