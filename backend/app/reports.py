"""Versioned, printable preparation report assembly backed by immutable analysis_runs snapshots."""

from datetime import datetime
import json
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import Connection, RowMapping

from app.analysis_runs import RUN_ORDER, RunHistory, load_run_history, load_run_payload, parse_analysis
from app.audit import record_audit_event
from app.models import analysis_runs, documents
from app.persistence import save_analysis
from app.workspace_access import document_scope, owned_business
from app.schemas.financial import (
    AnalysisRequest,
    AnalysisResponse,
    EvidenceState,
    FinancialField,
    Indicator,
)
from app.schemas.reports import (
    PreparationReportResponse,
    ReportDocumentReference,
    ReportMissingEvidenceItem,
    ReportSummary,
)

REPORT_LIMITATION = (
    "This preparation report summarizes reviewed inputs and deterministic Python calculations "
    "for discussion with an accountant or lender; it does not authenticate statements, "
    "assign credit scores, or predict loan approval."
)

STATE_ORDER: dict[EvidenceState, int] = {
    "Needs review": 0,
    "Not assessed": 1,
    "Not meaningful": 2,
    "Supported": 3,
}


def build_missing_evidence(
    analysis: AnalysisResponse,
) -> list[ReportMissingEvidenceItem]:
    grouped: dict[
        tuple[int, str, tuple[FinancialField, ...], str],
        tuple[EvidenceState, list[Indicator | str]],
    ] = {}

    for period in sorted(analysis.periods, key=lambda p: p.year_start):
        entries: list[tuple[Indicator | str, EvidenceState, list]] = [
            ("balance_check", period.balance_check.state, period.balance_check.reasons),
            *[
                (finding.indicator, finding.state, finding.reasons)
                for finding in period.indicators
            ],
        ]
        for target, state, reasons in entries:
            if state == "Supported":
                continue
            for reason in reasons:
                key = (
                    period.year_start,
                    reason.code,
                    tuple(reason.fields),
                    reason.message,
                )
                if key not in grouped:
                    grouped[key] = (state, [target])
                else:
                    existing_state, targets = grouped[key]
                    best_state = (
                        state
                        if STATE_ORDER[state] < STATE_ORDER[existing_state]
                        else existing_state
                    )
                    if target not in targets:
                        targets.append(target)
                    grouped[key] = (best_state, targets)

    items = [
        ReportMissingEvidenceItem(
            year_start=year_start,
            fields=list(fields),
            code=code,
            state=state,
            message=message,
            affected_analyses=targets,
        )
        for (year_start, code, fields, message), (state, targets) in grouped.items()
    ]
    items.sort(key=lambda item: (STATE_ORDER[item.state], item.year_start, item.code, item.message))
    return items


def build_documents_referenced(
    inputs: AnalysisRequest,
    available: set[UUID] | None = None,
) -> list[ReportDocumentReference]:
    refs: dict[tuple[UUID | None, str], set[int]] = {}
    for period in inputs.periods:
        for figure in period.values.values():
            if figure.origin == "document" and figure.source is not None:
                key = (figure.source.document_id, figure.source.filename)
                refs.setdefault(key, set()).add(figure.source.page_number)

    result = [
        ReportDocumentReference(
            document_id=doc_id,
            filename=filename,
            pages=sorted(pages),
            detached=doc_id is None or (available is not None and doc_id not in available),
        )
        for (doc_id, filename), pages in refs.items()
    ]
    result.sort(key=lambda ref: (ref.detached, ref.filename.lower(), str(ref.document_id or "")))
    return result


def _superseded_info(
    run_id: UUID,
    run_input_revision: int,
    current_input_revision: int,
    latest_run_id: UUID | None,
    latest_run_revision: int | None,
    version_map: dict[UUID, int],
) -> tuple[bool, str | None]:
    if run_input_revision == current_input_revision and run_id == latest_run_id:
        return False, None
    latest_version = version_map.get(latest_run_id) if latest_run_id is not None else None
    if run_input_revision < current_input_revision:
        if latest_version is not None and latest_run_revision == current_input_revision:
            return (
                True,
                f"Superseded by report v{latest_version} at workspace input revision {current_input_revision}.",
            )
        return (
            True,
            f"Superseded by workspace input revision {current_input_revision}. "
            "Re-run analysis or generate a refreshed report.",
        )
    if latest_version is not None:
        return (
            True,
            f"Superseded by newer report v{latest_version} at input revision {current_input_revision}.",
        )
    return True, "Superseded by a newer workspace revision."


def assemble_preparation_report(
    *,
    report_id: UUID,
    business_id: UUID,
    report_version: int,
    input_revision: int,
    current_input_revision: int,
    superseded: bool,
    superseded_reason: str | None,
    created_at: datetime,
    inputs: AnalysisRequest,
    analysis: AnalysisResponse,
    available_documents: set[UUID] | None = None,
) -> PreparationReportResponse:
    limitations = [*analysis.limitations]
    if REPORT_LIMITATION not in limitations:
        limitations.append(REPORT_LIMITATION)
    return PreparationReportResponse(
        report_id=report_id,
        business_id=business_id,
        report_version=report_version,
        input_revision=input_revision,
        current_input_revision=current_input_revision,
        rule_version=analysis.rule_version,
        action_version=analysis.action_version,
        superseded=superseded,
        superseded_reason=superseded_reason,
        created_at=created_at,
        business_name=inputs.business_name,
        currency=inputs.currency,
        basis=inputs.basis,
        inputs=inputs,
        analysis=analysis,
        missing_evidence=build_missing_evidence(analysis),
        documents_referenced=build_documents_referenced(inputs, available_documents),
        limitations=limitations,
    )


def _report_summary(history: RunHistory, row: RowMapping, versions: dict[UUID, int]) -> ReportSummary:
    latest = history.runs[0]
    superseded, reason = _superseded_info(
        row["id"], row["input_revision"], history.revision,
        latest["id"], latest["input_revision"], versions,
    )
    return ReportSummary(
        report_id=row["id"],
        business_id=row["business_id"],
        report_version=versions[row["id"]],
        input_revision=row["input_revision"],
        current_input_revision=history.revision,
        rule_version=row["rule_version"],
        action_version=row["action_version"],
        superseded=superseded,
        superseded_reason=reason,
        created_at=row["created_at"],
    )


def _report_versions(history: RunHistory) -> dict[UUID, int]:
    chronological = sorted(history.runs, key=lambda row: (row["created_at"], row["id"]))
    return {row["id"]: index for index, row in enumerate(chronological, 1)}


def list_reports(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> list[ReportSummary]:
    history = load_run_history(connection, owner_id, business_id)
    versions = _report_versions(history)
    return [_report_summary(history, row, versions) for row in history.runs]


def load_report(
    connection: Connection, owner_id: UUID, business_id: UUID, report_id: UUID
) -> PreparationReportResponse:
    history = load_run_history(connection, owner_id, business_id)
    target = next((row for row in history.runs if row["id"] == report_id), None)
    if target is None:
        raise LookupError("Report not found")
    summary = _report_summary(history, target, _report_versions(history))
    payload = load_run_payload(connection, owner_id, business_id, report_id, include_inputs=True)
    inputs = AnalysisRequest.model_validate_json(json.dumps(payload["inputs"]))
    analysis = parse_analysis(payload["results"])
    source_ids = {
        figure.source.document_id for period in inputs.periods for figure in period.values.values()
        if figure.source is not None and figure.source.document_id is not None
    }
    available_documents = set(connection.scalars(
        select(documents.c.id).where(
            *document_scope(owner_id, business_id),
            documents.c.id.in_(source_ids),
            documents.c.status == "ready",
        )
    )) if source_ids else set()
    return assemble_preparation_report(
        report_id=summary.report_id,
        business_id=summary.business_id,
        report_version=summary.report_version,
        input_revision=summary.input_revision,
        current_input_revision=summary.current_input_revision,
        superseded=summary.superseded,
        superseded_reason=summary.superseded_reason,
        created_at=summary.created_at,
        inputs=inputs,
        analysis=analysis,
        available_documents=available_documents,
    )


def generate_report(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> PreparationReportResponse:
    """Return the current preparation report for business_id, creating an analysis run if needed."""
    locked = owned_business(connection, owner_id, business_id, for_update=True)
    existing_run_id = connection.execute(
        select(analysis_runs.c.id)
        .where(
            analysis_runs.c.business_id == business_id,
            analysis_runs.c.input_revision == locked["input_revision"],
        )
        .order_by(*RUN_ORDER)
        .limit(1)
    ).scalar_one_or_none()
    run_id = (
        existing_run_id
        if existing_run_id is not None
        else save_analysis(connection, owner_id, business_id)
    )
    report = load_report(connection, owner_id, business_id, run_id)
    record_audit_event(
        connection,
        owner_id,
        "report_generated",
        resource_id=report.report_id,
        business_id=business_id,
        details={
            "input_revision": report.input_revision,
            "report_version": report.report_version,
        },
    )
    return report
