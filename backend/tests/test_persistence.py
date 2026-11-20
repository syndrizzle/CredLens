import json
import os
from decimal import Decimal, localcontext
from pathlib import Path
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from app.analysis import MULTIPLIERS, analyse
from app.database import get_engine
from app.models import analysis_runs, businesses, figures, owners, periods, revisions
from app.persistence import (
    load_analysis,
    load_business,
    load_workspace,
    save_analysis,
    save_business,
    update_business,
)
from app.schemas import AnalysisRequest, AnalysisResponse
from sqlalchemy import event, func, select, text
from sqlalchemy.exc import IntegrityError

pytestmark = pytest.mark.skipif(
    not os.getenv("PERSISTENCE_TEST_URL"),
    reason="Requires migrated disposable PostgreSQL database",
)


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    get_engine.cache_clear()
    engine = get_engine()
    owner = uuid4()
    with engine.begin() as connection:
        connection.execute(owners.insert().values(id=owner))
    try:
        yield engine, owner
    finally:
        with engine.begin() as connection:
            connection.execute(
                businesses.delete().where(businesses.c.owner_id == owner)
            )
            connection.execute(owners.delete().where(owners.c.id == owner))
        engine.dispose()
        get_engine.cache_clear()


@pytest.fixture
def request_data():
    raw = json.loads(
        (Path(__file__).parent / "fixtures/aster_components.json").read_text()
    )["request"]
    for period in raw["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = True
    return AnalysisRequest.model_validate(raw)


def test_committed_fixture_survives_reconnect_with_findings(db, request_data):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
    engine.dispose()
    with engine.connect() as connection:
        assert load_business(connection, owner, business) == request_data
        loaded_run = load_analysis(connection, owner, run)
        assert loaded_run == analyse(request_data)
        assert loaded_run.run_id == run
        assert loaded_run.business_id == business
        assert loaded_run.input_revision == 1
        assert loaded_run.superseded is False
        stored = (
            connection.execute(select(analysis_runs).where(analysis_runs.c.id == run))
            .mappings()
            .one()
        )
        assert stored["inputs"] == request_data.model_dump(mode="json")
        assert stored["input_revision"] == 1
        assert stored["rule_version"] == "financial-rules-v1"
        assert stored["created_at"].tzinfo is not None


def test_exact_amounts_missing_zero_and_revision(db, request_data):
    engine, owner = db
    period = request_data.periods[1]
    period.unit = "crores"
    period.values["revenue"].raw = " +999999999999999.99 "
    period.values["revenue"].revision = 7
    period.values["interest_expense"].raw = " "
    period.values["interest_expense"].reviewed = False
    period.values["current_maturities"].raw = "0"
    del period.values["ebit"]
    with engine.begin() as connection, localcontext() as context:
        context.prec = 2
        business = save_business(connection, owner, request_data)
    with engine.connect() as connection:
        loaded = load_business(connection, owner, business)
        assert loaded == request_data
        pid = connection.execute(
            select(periods.c.id).where(
                periods.c.business_id == business, periods.c.year_start == 2024
            )
        ).scalar_one()
        amounts = {
            row.field: row.normalized_inr
            for row in connection.execute(
                select(figures).where(figures.c.period_id == pid)
            )
        }
        assert amounts["revenue"] == Decimal("9999999999999999900000")
        assert amounts["interest_expense"] is None
        assert amounts["current_maturities"] == 0
        assert "ebit" not in amounts


def test_owner_boundaries(db, request_data):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
    with engine.connect() as connection:
        for wrong in (uuid4(), uuid4()):
            with pytest.raises(LookupError, match="Business not found"):
                load_business(connection, wrong, business)
            with pytest.raises(LookupError, match="Business not found"):
                save_analysis(connection, wrong, business)
            with pytest.raises(LookupError, match="Analysis not found"):
                load_analysis(connection, wrong, run)
        with pytest.raises(LookupError):
            load_business(connection, owner, uuid4())


def test_failed_transaction_is_atomic(db, request_data):
    engine, owner = db
    with pytest.raises(RuntimeError):
        with engine.begin() as connection:
            save_business(connection, owner, request_data)
            raise RuntimeError("simulated interrupted save")
    with engine.connect() as connection:
        assert (
            connection.execute(
                select(func.count())
                .select_from(businesses)
                .where(businesses.c.owner_id == owner)
            ).scalar_one()
            == 0
        )


def test_constraints_reject_unknown_owner_and_duplicate_year(db, request_data):
    engine, owner = db
    with pytest.raises(IntegrityError), engine.begin() as connection:
        save_business(connection, uuid4(), request_data)
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(
            periods.insert().values(
                id=uuid4(),
                business_id=business,
                year_start=2023,
                unit="rupees",
                multiplier=1,
                comparable_to_prior=False,
            )
        )


def test_empty_period_round_trip(db, request_data):
    engine, owner = db
    request_data.periods = request_data.periods[:1]
    request_data.periods[0].values = {}
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
    with engine.connect() as connection:
        assert load_business(connection, owner, business).periods[0].values == {}
        assert all(
            f.state == "Not assessed"
            for f in load_analysis(connection, owner, run).periods[0].indicators
        )


@pytest.mark.parametrize(
    "variant",
    [
        "missing_interest",
        "unreviewed",
        "balance",
        "component",
        "mixed_units",
        "gap",
        "comparison",
    ],
)
def test_saved_dependency_cases_and_actions_survive_reload(db, request_data, variant):
    engine, owner = db
    current = request_data.periods[1]
    if variant == "missing_interest":
        del current.values["interest_expense"]
    elif variant == "unreviewed":
        current.values["current_assets"].reviewed = False
    elif variant == "balance":
        current.values["total_assets"].raw = "13000000"
    elif variant == "component":
        current.values["current_assets"].raw = "13000000"
    elif variant == "mixed_units":
        current.unit = "lakhs"
        for figure in current.values.values():
            figure.raw = str(figure.amount / Decimal("100000"))
    elif variant == "gap":
        request_data.periods[0].year_start = 2022
    elif variant == "comparison":
        current.comparable_to_prior = False
    expected = analyse(request_data)
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
    engine.dispose()
    with engine.connect() as connection:
        actual = load_analysis(connection, owner, run)
        assert actual == expected
        assert actual.action_version == "preparation-actions-v1"
        assert load_workspace(connection, owner, business).latest_analysis == expected
        stored = connection.execute(
            select(analysis_runs.c.results).where(analysis_runs.c.id == run)
        ).scalar_one()
        assert stored["actions"] == expected.model_dump(mode="json")["actions"]
        affected = {
            "missing_interest": {"interest_coverage"},
            "unreviewed": {"working_capital", "current_ratio"},
            "balance": {"working_capital", "current_ratio", "debt_to_equity"},
            "component": {"working_capital", "current_ratio", "debt_to_equity"},
            "mixed_units": set(),
            "gap": {"revenue_growth"},
            "comparison": {"revenue_growth"},
        }[variant]
        assert {
            finding.indicator
            for finding in actual.periods[1].indicators
            if finding.state != "Supported"
        } == affected
        with pytest.raises(LookupError):
            load_workspace(connection, uuid4(), business)


def test_legacy_saved_run_remains_readable_without_inventing_actions(db, request_data):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
        legacy = analyse(request_data).model_dump(
            mode="json", exclude={"actions", "action_version"}
        )
        connection.execute(
            analysis_runs.update()
            .where(analysis_runs.c.id == run)
            .values(results=legacy)
        )
    with engine.connect() as connection:
        actual = load_workspace(connection, owner, business).latest_analysis
        assert actual.action_version is None and actual.actions == []
        assert actual.periods == analyse(request_data).periods


def test_corrections_persist_reviewer_revisions_invalidate_outputs_and_retain_superseded_history(
    db, request_data
):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run_1 = save_analysis(connection, owner, business)
        ws_1 = load_workspace(connection, owner, business)
        assert ws_1.input_revision == 1
        assert ws_1.latest_run_id == run_1
        assert ws_1.latest_analysis == analyse(request_data)
        assert len(ws_1.runs) == 1
        assert (
            ws_1.runs[0].run_id == run_1
            and ws_1.runs[0].input_revision == 1
            and not ws_1.runs[0].superseded
        )
        direct_run_1 = load_analysis(connection, owner, run_1)
        assert direct_run_1.input_revision == 1 and direct_run_1.superseded is False

        # Correct FY 2024-25 interest_expense to 300000.00 (unreviewed) and save in place.
        edited = request_data.model_copy(deep=True)
        edited.periods[1].values["interest_expense"].raw = "300000.00"
        edited.periods[1].values["interest_expense"].reviewed = False
        rev_2 = update_business(
            connection, owner, business, edited, expected_revision=1
        )
        assert rev_2 == 2
        ws_2 = load_workspace(connection, owner, business)
        assert ws_2.input_revision == 2
        assert ws_2.latest_run_id is None
        assert ws_2.latest_analysis is None
        assert len(ws_2.runs) == 1
        assert (
            ws_2.runs[0].run_id == run_1
            and ws_2.runs[0].input_revision == 1
            and ws_2.runs[0].superseded
        )
        direct_run_1_after_edit = load_analysis(connection, owner, run_1)
        assert (
            direct_run_1_after_edit.input_revision == 1
            and direct_run_1_after_edit.superseded is True
        )

        pid_2024 = connection.execute(
            select(periods.c.id).where(
                periods.c.business_id == business, periods.c.year_start == 2024
            )
        ).scalar_one()
        fig_rows = {
            row["field"]: row
            for row in connection.execute(
                select(figures).where(figures.c.period_id == pid_2024)
            ).mappings()
        }
        assert fig_rows["interest_expense"]["revision"] == 2
        assert fig_rows["interest_expense"]["reviewed"] is False
        assert fig_rows["interest_expense"]["reviewed_by"] is None
        assert fig_rows["interest_expense"]["origin"] == "manual"
        assert fig_rows["ebit"]["revision"] == 1
        assert fig_rows["ebit"]["reviewed"] is True
        assert fig_rows["ebit"]["reviewed_by"] == owner

        # Confirm the corrected interest_expense without changing its raw amount, then re-analyse.
        confirmed = ws_2.request.model_copy(deep=True)
        confirmed.periods[1].values["interest_expense"].reviewed = True
        rev_3 = update_business(
            connection, owner, business, confirmed, expected_revision=2
        )
        assert rev_3 == 3
        run_2 = save_analysis(connection, owner, business)
        ws_3 = load_workspace(connection, owner, business)
        assert ws_3.input_revision == 3
        assert ws_3.latest_run_id == run_2
        assert ws_3.latest_analysis is not None
        coverage = next(
            item
            for item in ws_3.latest_analysis.periods[1].indicators
            if item.indicator == "interest_coverage"
        )
        assert coverage.state == "Supported" and coverage.value == Decimal("4")
        by_field = {inp.field: inp for inp in coverage.inputs}
        assert by_field["ebit"].figure.revision == 1
        assert by_field["interest_expense"].figure.revision == 2
        assert [(r.run_id, r.input_revision, r.superseded) for r in ws_3.runs] == [
            (run_2, 3, False),
            (run_1, 1, True),
        ]
        direct_run_2 = load_analysis(connection, owner, run_2)
        assert direct_run_2.input_revision == 3 and direct_run_2.superseded is False
        direct_run_1_final = load_analysis(connection, owner, run_1)
        assert (
            direct_run_1_final.input_revision == 1
            and direct_run_1_final.superseded is True
        )

        rev_history = (
            connection.execute(
                select(revisions)
                .where(revisions.c.business_id == business)
                .order_by(revisions.c.input_revision)
            )
            .mappings()
            .all()
        )
        assert [row["input_revision"] for row in rev_history] == [1, 2, 3]
        assert all(row["actor_id"] == owner for row in rev_history)
        assert (
            rev_history[1]["inputs"]["periods"][1]["values"]["interest_expense"][
                "reviewed"
            ]
            is False
        )
        assert (
            rev_history[2]["inputs"]["periods"][1]["values"]["interest_expense"][
                "reviewed"
            ]
            is True
        )


def test_optimistic_concurrency_omitted_field_readdition_and_reviewer_constraint(
    db, request_data
):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        without_interest = request_data.model_copy(deep=True)
        del without_interest.periods[1].values["interest_expense"]
        assert (
            update_business(
                connection, owner, business, without_interest, expected_revision=1
            )
            == 2
        )

        with pytest.raises(ValueError, match="updated in another session"):
            update_business(
                connection, owner, business, request_data, expected_revision=1
            )
        with pytest.raises(LookupError, match="Business not found"):
            update_business(
                connection, uuid4(), business, request_data, expected_revision=1
            )

        restored = without_interest.model_copy(deep=True)
        restored.periods[1].values["interest_expense"] = (
            request_data.periods[1].values["interest_expense"].model_copy()
        )
        assert (
            update_business(connection, owner, business, restored, expected_revision=2)
            == 3
        )
        loaded = load_business(connection, owner, business)
        assert loaded.periods[1].values["interest_expense"].revision == 2
        pid = connection.execute(
            select(periods.c.id).where(
                periods.c.business_id == business, periods.c.year_start == 2024
            )
        ).scalar_one()

    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(
            figures.insert().values(
                period_id=pid,
                field="revenue",
                raw="100",
                normalized_inr=Decimal("100"),
                origin="manual",
                reviewed=True,
                reviewed_by=None,
                revision=1,
            )
        )
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(
            figures.update()
            .where(figures.c.period_id == pid, figures.c.field == "revenue")
            .values(reviewed=False, reviewed_by=owner)
        )


def test_concurrent_correction_interleaves_keep_workspace_reads_and_analysis_snapshots_consistent(
    db, request_data
):
    engine, owner = db
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run_1 = save_analysis(connection, owner, business)

    # Interleave 1: concurrent update commits right after load_workspace's first SELECT on businesses.
    edited_rev2 = request_data.model_copy(deep=True)
    edited_rev2.periods[1].values["interest_expense"].raw = "200000.00"
    interleaved_read = {"triggered": False}

    with engine.begin() as conn1:

        def on_read_select(
            _conn, _cursor, statement, _parameters, _context, _executemany
        ):
            if not interleaved_read["triggered"] and "FROM businesses" in statement:
                interleaved_read["triggered"] = True
                with engine.begin() as conn2:
                    assert (
                        update_business(
                            conn2, owner, business, edited_rev2, expected_revision=1
                        )
                        == 2
                    )

        event.listen(conn1, "after_cursor_execute", on_read_select)
        try:
            ws = load_workspace(conn1, owner, business)
        finally:
            event.remove(conn1, "after_cursor_execute", on_read_select)

    assert interleaved_read["triggered"] is True
    assert ws.input_revision == 2
    assert ws.request.periods[1].values["interest_expense"].raw == "200000.00"
    assert ws.request.periods[1].values["interest_expense"].revision == 2
    assert ws.latest_run_id is None
    assert ws.latest_analysis is None
    assert [(r.run_id, r.input_revision, r.superseded) for r in ws.runs] == [
        (run_1, 1, True)
    ]

    # Interleave 2: concurrent update commits right after save_analysis's first SELECT on businesses.
    edited_rev3 = edited_rev2.model_copy(deep=True)
    edited_rev3.periods[1].values["interest_expense"].raw = "300000.00"
    interleaved_save = {"triggered": False}

    with engine.begin() as conn1:

        def on_save_select(
            _conn, _cursor, statement, _parameters, _context, _executemany
        ):
            if not interleaved_save["triggered"] and "FROM businesses" in statement:
                interleaved_save["triggered"] = True
                with engine.begin() as conn2:
                    assert (
                        update_business(
                            conn2, owner, business, edited_rev3, expected_revision=2
                        )
                        == 3
                    )

        event.listen(conn1, "after_cursor_execute", on_save_select)
        try:
            run_3 = save_analysis(conn1, owner, business)
        finally:
            event.remove(conn1, "after_cursor_execute", on_save_select)

    assert interleaved_save["triggered"] is True
    with engine.connect() as connection:
        stored = (
            connection.execute(select(analysis_runs).where(analysis_runs.c.id == run_3))
            .mappings()
            .one()
        )
        current_request = load_business(connection, owner, business)
        assert stored["input_revision"] == 3
        assert stored["inputs"] == current_request.model_dump(mode="json")
        assert (
            stored["inputs"]["periods"][1]["values"]["interest_expense"]["raw"]
            == "300000.00"
        )
        assert (
            stored["inputs"]["periods"][1]["values"]["interest_expense"]["revision"]
            == 3
        )
        assert AnalysisResponse.model_validate_json(
            json.dumps(stored["results"])
        ) == analyse(current_request)


def test_populated_upgrade_and_preexisting_baseline_preserve_monotonic_revisions(
    db, request_data, monkeypatch
):
    engine, owner = db
    monkeypatch.setenv("DATABASE_URL_UNPOOLED", os.environ["PERSISTENCE_TEST_URL"])
    get_engine.cache_clear()
    migration_engine = get_engine(direct=True)
    if migration_engine.url != engine.url or "-pooler." in (
        migration_engine.url.host or ""
    ):
        pytest.fail(
            "Migration test requires the same direct disposable database as the persistence fixture"
        )
    alembic_cfg = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    business_id = uuid4()

    command.downgrade(alembic_cfg, "7c84f91a3d02")
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO businesses (id, owner_id, name, currency, basis, input_revision) "
                    "VALUES (:id, :owner_id, :name, :currency, :basis, 1)"
                ),
                dict(
                    id=business_id,
                    owner_id=owner,
                    name=request_data.business_name,
                    currency=request_data.currency,
                    basis=request_data.basis,
                ),
            )
            for period in request_data.periods:
                pid = uuid4()
                mult = MULTIPLIERS[period.unit]
                connection.execute(
                    text(
                        "INSERT INTO periods (id, business_id, year_start, unit, multiplier, comparable_to_prior) "
                        "VALUES (:id, :business_id, :year_start, :unit, :multiplier, :comparable_to_prior)"
                    ),
                    dict(
                        id=pid,
                        business_id=business_id,
                        year_start=period.year_start,
                        unit=period.unit,
                        multiplier=mult,
                        comparable_to_prior=period.comparable_to_prior,
                    ),
                )
                for field, figure in period.values.items():
                    rev = (
                        8
                        if (period.year_start == 2024 and field == "interest_expense")
                        else 1
                    )
                    connection.execute(
                        text(
                            "INSERT INTO figures (period_id, field, raw, normalized_inr, origin, reviewed, revision) "
                            "VALUES (:period_id, :field, :raw, :normalized_inr, :origin, :reviewed, :revision)"
                        ),
                        dict(
                            period_id=pid,
                            field=field,
                            raw=figure.raw,
                            normalized_inr=None
                            if figure.amount is None
                            else figure.amount * mult,
                            origin=figure.origin,
                            reviewed=figure.reviewed,
                            revision=rev,
                        ),
                    )
    finally:
        command.upgrade(alembic_cfg, "head")

    with engine.begin() as connection:
        baseline = (
            connection.execute(
                select(revisions).where(revisions.c.business_id == business_id)
            )
            .mappings()
            .one()
        )
        assert baseline["input_revision"] == 1
        assert baseline["actor_id"] == owner
        assert (
            baseline["inputs"]["periods"][1]["values"]["interest_expense"]["revision"]
            == 8
        )

        # Also verify update_business snapshots prior inputs even if baseline row was absent.
        connection.execute(
            revisions.delete().where(revisions.c.business_id == business_id)
        )
        without_interest = load_business(connection, owner, business_id)
        del without_interest.periods[1].values["interest_expense"]
        assert (
            update_business(
                connection, owner, business_id, without_interest, expected_revision=1
            )
            == 2
        )

        restored = without_interest.model_copy(deep=True)
        restored.periods[1].values["interest_expense"] = (
            request_data.periods[1].values["interest_expense"].model_copy()
        )
        assert (
            update_business(
                connection, owner, business_id, restored, expected_revision=2
            )
            == 3
        )

        loaded = load_business(connection, owner, business_id)
        assert loaded.periods[1].values["interest_expense"].revision == 9
        rev_rows = (
            connection.execute(
                select(revisions.c.input_revision)
                .where(revisions.c.business_id == business_id)
                .order_by(revisions.c.input_revision)
            )
            .scalars()
            .all()
        )
        assert rev_rows == [1, 2, 3]
