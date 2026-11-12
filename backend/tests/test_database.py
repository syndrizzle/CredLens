import os
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlalchemy.pool import NullPool

from app.database import get_engine
from app.main import app


@pytest.fixture(autouse=True)
def reset_engine():
    get_engine.cache_clear()
    yield
    get_engine.cache_clear()


def test_database_url_and_pool(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:secret@example.com/db?sslmode=verify-full")
    with patch("app.database.load_dotenv"):
        engine = get_engine()
    assert engine.url.drivername == "postgresql+psycopg"
    assert engine.url.query["sslmode"] == "verify-full"
    assert isinstance(engine.pool, NullPool)
    assert engine.hide_parameters
    engine.dispose()


@pytest.mark.parametrize("raw", [None, "not a URL", "sqlite:///test.db"])
def test_invalid_configuration(raw, monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    if raw is not None:
        monkeypatch.setenv("DATABASE_URL", raw)
    with patch("app.database.load_dotenv"), pytest.raises(RuntimeError):
        get_engine()


def test_database_health_redacts_failure():
    with TestClient(app) as client, patch("app.main.check_database") as check:
        assert client.get("/api/health/database").json() == {"status": "ok", "database": "connected"}
        check.side_effect = OperationalError("secret connection", {}, Exception("private hostname"))
        failed = client.get("/api/health/database")
        assert failed.status_code == 503
        assert failed.json() == {"detail": "Database unavailable"}
        assert client.get("/api/health").status_code == 200


@pytest.mark.skipif(os.getenv("RUN_NEON_TESTS") != "1", reason="Opt-in live Neon verification")
def test_live_neon_transaction_and_api():
    engine = get_engine()
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text("CREATE TEMP TABLE credlens_connection_probe (amount numeric) ON COMMIT DROP"))
            connection.execute(text("INSERT INTO credlens_connection_probe (amount) VALUES (:amount)"), {"amount": "123.45"})
            assert str(connection.execute(text("SELECT amount FROM credlens_connection_probe")).scalar_one()) == "123.45"
        finally:
            transaction.rollback()
    with TestClient(app) as client:
        assert client.get("/api/health/database").json() == {"status": "ok", "database": "connected"}
    engine.dispose()
