from unittest.mock import Mock
from uuid import uuid4

import pytest
from app.database import get_engine
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url
from test_persistence import (
    command,
)
from test_persistence import (
    test_populated_upgrade_and_preexisting_baseline_preserve_monotonic_revisions as run_populated_upgrade,
)

TEST_URL = "postgresql://user:secret@disposable.example/test?sslmode=require"
APPLICATION_URL = "postgresql://user:secret@application.example/app?sslmode=require"
POOLED_URL = "postgresql://user:secret@ep-test-pooler.example/test?sslmode=require"


class StoppedBeforeDDL(Exception):
    pass


@pytest.fixture
def fixture_engine(monkeypatch, request, tmp_path):
    url = getattr(request, "param", TEST_URL)
    monkeypatch.setenv("PERSISTENCE_TEST_URL", url)
    monkeypatch.setattr("app.settings._ROOT", tmp_path)
    get_engine.cache_clear()
    engine = create_engine(make_url(url).set(drivername="postgresql+psycopg"))
    monkeypatch.setattr(
        engine,
        "connect",
        Mock(
            side_effect=AssertionError(
                "No database access is allowed in migration safety tests"
            )
        ),
    )
    yield engine
    engine.dispose()
    get_engine.cache_clear()


@pytest.mark.parametrize("inherited", ["application", "absent", "cached"])
def test_migration_uses_fixture_database_despite_application_configuration(
    fixture_engine, monkeypatch, inherited
):
    if inherited == "absent":
        monkeypatch.delenv("DATABASE_URL_UNPOOLED", raising=False)
    else:
        monkeypatch.setenv("DATABASE_URL_UNPOOLED", APPLICATION_URL)
    if inherited == "cached":
        get_engine(
            direct=True
        )  # No connection is opened; emulate an inherited engine cache.

    def stop_before_ddl(*_args):
        assert get_engine(direct=True).url == fixture_engine.url
        raise StoppedBeforeDDL

    downgrade = Mock(side_effect=stop_before_ddl)
    upgrade = Mock()
    monkeypatch.setattr(command, "downgrade", downgrade)
    monkeypatch.setattr(command, "upgrade", upgrade)
    with pytest.raises(StoppedBeforeDDL):
        run_populated_upgrade((fixture_engine, uuid4()), None, monkeypatch)
    downgrade.assert_called_once()
    upgrade.assert_not_called()


@pytest.mark.parametrize(
    "fixture_engine,unsafe_url",
    [(TEST_URL, APPLICATION_URL), (POOLED_URL, POOLED_URL)],
    indirect=["fixture_engine"],
)
def test_migration_rejects_mismatched_or_pooled_database_before_ddl(
    fixture_engine, monkeypatch, unsafe_url
):
    monkeypatch.setenv("PERSISTENCE_TEST_URL", unsafe_url)
    downgrade, upgrade = Mock(), Mock()
    monkeypatch.setattr(command, "downgrade", downgrade)
    monkeypatch.setattr(command, "upgrade", upgrade)
    with pytest.raises(pytest.fail.Exception, match="same direct disposable database"):
        run_populated_upgrade((fixture_engine, uuid4()), None, monkeypatch)
    downgrade.assert_not_called()
    upgrade.assert_not_called()
