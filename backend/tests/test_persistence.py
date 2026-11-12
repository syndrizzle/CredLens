import json
import os
from decimal import Decimal, localcontext
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import select, func
from sqlalchemy.exc import IntegrityError

from app.analysis import analyse
from app.database import get_engine
from app.models import owners, businesses, periods, figures, analysis_runs
from app.persistence import save_business, load_business, save_analysis, load_analysis
from app.schemas import AnalysisRequest

pytestmark = pytest.mark.skipif(not os.getenv("PERSISTENCE_TEST_URL"), reason="Requires migrated disposable PostgreSQL database")


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
            connection.execute(businesses.delete().where(businesses.c.owner_id == owner))
            connection.execute(owners.delete().where(owners.c.id == owner))
        engine.dispose()
        get_engine.cache_clear()


@pytest.fixture
def request_data():
    raw = json.loads((Path(__file__).parent / "fixtures/aster_components.json").read_text())["request"]
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
        assert load_analysis(connection, owner, run) == analyse(request_data)
        stored = connection.execute(select(analysis_runs).where(analysis_runs.c.id == run)).mappings().one()
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
        pid = connection.execute(select(periods.c.id).where(periods.c.business_id == business, periods.c.year_start == 2024)).scalar_one()
        amounts = {row.field: row.normalized_inr for row in connection.execute(select(figures).where(figures.c.period_id == pid))}
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
        assert connection.execute(select(func.count()).select_from(businesses).where(businesses.c.owner_id == owner)).scalar_one() == 0


def test_constraints_reject_unknown_owner_and_duplicate_year(db, request_data):
    engine, owner = db
    with pytest.raises(IntegrityError), engine.begin() as connection:
        save_business(connection, uuid4(), request_data)
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
    with pytest.raises(IntegrityError), engine.begin() as connection:
        connection.execute(periods.insert().values(id=uuid4(), business_id=business, year_start=2023,
            unit="rupees", multiplier=1, comparable_to_prior=False))


def test_empty_period_round_trip(db, request_data):
    engine, owner = db
    request_data.periods = request_data.periods[:1]
    request_data.periods[0].values = {}
    with engine.begin() as connection:
        business = save_business(connection, owner, request_data)
        run = save_analysis(connection, owner, business)
    with engine.connect() as connection:
        assert load_business(connection, owner, business).periods[0].values == {}
        assert all(f.state == "Not assessed" for f in load_analysis(connection, owner, run).periods[0].indicators)
