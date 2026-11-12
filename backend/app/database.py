import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, text
from sqlalchemy.engine import Engine, make_url
from sqlalchemy.pool import NullPool
from sqlalchemy.exc import ArgumentError


@lru_cache
def get_engine() -> Engine:
    root = Path(__file__).resolve().parents[2]
    load_dotenv(root / (".env" if (root / ".env").exists() else ".env.local"), override=False)
    raw = os.environ.get("DATABASE_URL")
    if not raw:
        raise RuntimeError("DATABASE_URL is not configured")
    try:
        url = make_url(raw)
        if url.get_backend_name() not in {"postgres", "postgresql"}:
            raise ValueError
        url = url.set(drivername="postgresql+psycopg")
    except (ArgumentError, ValueError, TypeError):
        raise RuntimeError("DATABASE_URL must be a PostgreSQL connection URL") from None
    if "sslmode" not in url.query:
        url = url.update_query_dict({"sslmode": "require"})
    # Neon supplies pooling; avoid keeping a second pool of idle connections locally.
    return create_engine(url, poolclass=NullPool, hide_parameters=True,
                         connect_args={"connect_timeout": 10, "prepare_threshold": None})


def check_database() -> None:
    with get_engine().connect() as connection:
        if connection.execute(text("SELECT 1")).scalar_one() != 1:
            raise RuntimeError("Database check failed")
