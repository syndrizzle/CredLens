"""Read backend settings independently of database access."""

import os
from pathlib import Path

from dotenv.main import DotEnv

_ROOT = Path(__file__).resolve().parents[2]


def setting(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is not None:
        return value
    if os.environ.get("PYTHON_DOTENV_DISABLED", "").casefold() in {"1", "true", "t", "yes", "y"}:
        return default
    path = _ROOT / ".env"
    if not path.exists():
        path = _ROOT / ".env.local"
    value = DotEnv(path, override=False, encoding="utf-8").dict().get(name)
    return default if value is None else value
