"""Versioned, printable preparation report assembly backed by immutable analysis_runs snapshots."""

from datetime import datetime
import json
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.engine import Connection

from app.models import analysis_runs
from app.persistence import owned_business, save_analysis
from app.schemas import (
    AnalysisRequest,
    AnalysisResponse,
    EvidenceState,
    FinancialField,
    Indicator,
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
    """Group non-supported evidence gaps with the exact analyses each item blocks."""
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
) -> list[ReportDocumentReference]:
    """Summarize source PDF documents and pages cited by document-origin figures."""
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
            detached=doc_id is None,
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
) -> PreparationReportResponse:
    """Assemble a validated PreparationReportResponse from immutable run snapshots."""
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
        documents_referenced=build_documents_referenced(inputs),
        limitations=limitations,
    )


def _load_runs_consistent(
    connection: Connection,
    owner_id: UUID,
    business_id: UUID,
    *,
    include_payloads: bool = True,
) -> tuple[int, list[dict]]:
    cols = [
        analysis_runs.c.id,
        analysis_runs.c.business_id,
        analysis_runs.c.input_revision,
        analysis_runs.c.rule_version,
        analysis_runs.c.created_at,
    ]
    if include_payloads:
        cols.extend([analysis_runs.c.inputs, analysis_runs.c.results])
    else:
        cols.append(
            analysis_runs.c.results["action_version"].astext.label("action_version")
        )
    while True:
        business = owned_business(connection, owner_id, business_id)
        current_rev = business["input_revision"]
        rows = (
            connection.execute(
                select(*cols)
                .where(analysis_runs.c.business_id == business_id)
                .order_by(analysis_runs.c.created_at.asc(), analysis_runs.c.id.asc())
            )
            .mappings()
            .all()
        )
        after = owned_business(connection, owner_id, business_id)
        if after["input_revision"] == current_rev and all(
            row["input_revision"] <= current_rev for row in rows
        ):
            return current_rev, [dict(row) for row in rows]


def _index_runs(
    rows: list[dict],
) -> tuple[dict[UUID, int], dict | None]:
    # Rows arrive chronologically ascending (created_at, id) for stable 1-based version numbering.
    version_map = {row["id"]: idx for idx, row in enumerate(rows, start=1)}
    latest = (
        max(
            rows,
            key=lambda row: (row["input_revision"], row["created_at"], str(row["id"])),
        )
        if rows
        else None
    )
    return version_map, latest


def list_reports(
    connection: Connection, owner_id: UUID, business_id: UUID
) -> list[ReportSummary]:
    current_rev, rows = _load_runs_consistent(
        connection, owner_id, business_id, include_payloads=False
    )
    version_map, latest = _index_runs(rows)
    latest_id = latest["id"] if latest is not None else None
    latest_rev = latest["input_revision"] if latest is not None else None

    ordered = sorted(
        rows,
        key=lambda row: (row["input_revision"], row["created_at"], str(row["id"])),
        reverse=True,
    )
    summaries: list[ReportSummary] = []
    for row in ordered:
        superseded, reason = _superseded_info(
            row["id"],
            row["input_revision"],
            current_rev,
            latest_id,
            latest_rev,
            version_map,
        )
        summaries.append(
            ReportSummary(
                report_id=row["id"],
                business_id=row["business_id"],
                report_version=version_map[row["id"]],
                input_revision=row["input_revision"],
                current_input_revision=current_rev,
                rule_version=row["rule_version"],
                action_version=row["action_version"],
                superseded=superseded,
                superseded_reason=reason,
                created_at=row["created_at"],
            )
        )
    return summaries


def load_report(
    connection: Connection, owner_id: UUID, business_id: UUID, report_id: UUID
) -> PreparationReportResponse:
    current_rev, rows = _load_runs_consistent(connection, owner_id, business_id)
    target = next((row for row in rows if row["id"] == report_id), None)
    if target is None:
        raise LookupError("Report not found")
    version_map, latest = _index_runs(rows)
    latest_id = latest["id"] if latest is not None else None
    latest_rev = latest["input_revision"] if latest is not None else None
    superseded, reason = _superseded_info(
        target["id"],
        target["input_revision"],
        current_rev,
        latest_id,
        latest_rev,
        version_map,
    )
    inputs = AnalysisRequest.model_validate_json(json.dumps(target["inputs"]))
    analysis = AnalysisResponse.model_validate_json(json.dumps(target["results"]))
    return assemble_preparation_report(
        report_id=target["id"],
        business_id=target["business_id"],
        report_version=version_map[target["id"]],
        input_revision=target["input_revision"],
        current_input_revision=current_rev,
        superseded=superseded,
        superseded_reason=reason,
        created_at=target["created_at"],
        inputs=inputs,
        analysis=analysis,
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
        .order_by(analysis_runs.c.created_at.desc(), analysis_runs.c.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    run_id = (
        existing_run_id
        if existing_run_id is not None
        else save_analysis(connection, owner_id, business_id)
    )
    return load_report(connection, owner_id, business_id, run_id)
