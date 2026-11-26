import os

import pytest


@pytest.fixture(autouse=True)
def _no_live_model(monkeypatch):
    # .env.local points at the deployed Worker; tests stay offline unless RUN_LIVE_MODEL_TESTS=1.
    if os.getenv("RUN_LIVE_MODEL_TESTS", "").strip() != "1":
        monkeypatch.setenv("CREDLENS_AI_DISABLED", "1")
