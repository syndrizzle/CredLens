from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
import pytest
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError

from app.auth import SESSION_COOKIE, hash_password, verify_password, _token_hash
from app.database import get_engine
from app.main import app
import app.main as main_module
from app.models import accounts, businesses, owners, sessions
from app.schemas import CredentialsRequest


def test_password_hashing_uses_scrypt_and_random_salt():
    first = hash_password("correct-horse-battery-staple")
    second = hash_password("correct-horse-battery-staple")
    assert first.startswith("scrypt$16384$8$1$")
    assert first != second
    assert verify_password("correct-horse-battery-staple", first)
    assert verify_password("correct-horse-battery-staple", second)
    assert not verify_password("wrong-horse-battery-staple", first)
    assert not verify_password("correct-horse-battery-staple", "bcrypt$invalid")
    assert not verify_password("correct-horse-battery-staple", "scrypt$bad")


def test_credentials_request_normalizes_email_and_enforces_lengths():
    req = CredentialsRequest(email="  Owner@Example.COM ", password="twelve-chars")
    assert req.email == "owner@example.com"
    with pytest.raises(ValueError):
        CredentialsRequest(email="not-an-email", password="twelve-chars")
    with pytest.raises(ValueError):
        CredentialsRequest(email="owner@example.com", password="short")


def test_validation_error_strips_submitted_password_and_email():
    client = TestClient(app)
    secret = "short-secret"
    response = client.post("/api/auth/register", json={"email": "bad-email", "password": secret})
    assert response.status_code == 422
    text = response.text
    assert secret not in text
    assert "bad-email" not in text


def test_protected_routes_return_503_when_database_unavailable(monkeypatch):
    @contextmanager
    def broken_db():
        raise RuntimeError("Database not configured")
        yield

    monkeypatch.setattr(main_module, " get_engine", lambda: (_ for _ in ()).throw(RuntimeError("no db")), raising=False)
    monkeypatch.setattr(main_module, "get_engine", lambda: (_ for _ in ()).throw(RuntimeError("no db")))
    client = TestClient(app)
    assert client.get("/api/auth/session").status_code == 503
    assert client.get("/api/businesses").status_code == 503


def test_update_business_route_enforces_schema_and_maps_conflict_and_not_found(monkeypatch):
    raw_fixture = json.loads((Path(__file__).parent / "fixtures/aster_components.json").read_text())["request"]
    client = TestClient(app)
    bid = uuid4()
    assert client.put(f"/api/businesses/{bid}", json=raw_fixture).status_code == 422
    assert client.put(f"/api/businesses/{bid}", json={**raw_fixture, "expected_revision": 0}).status_code == 422
    assert client.put(f"/api/businesses/{bid}", json={**raw_fixture, "expected_revision": 1, "owner_id": str(uuid4())}).status_code == 422

    @contextmanager
    def dummy_tx():
        yield object()

    monkeypatch.setattr(main_module, "db_transaction", dummy_tx)
    monkeypatch.setattr(main_module, "require_session", lambda _conn, _req: main_module.SessionResponse(owner_id=uuid4(), email="owner@example.com"))
    monkeypatch.setattr(main_module, "update_business", lambda *_args: (_ for _ in ()).throw(ValueError("Workspace has been updated in another session; reload before saving")))
    conflict = client.put(f"/api/businesses/{bid}", json={**raw_fixture, "expected_revision": 1})
    assert conflict.status_code == 409
    assert conflict.json() == {"detail": "Workspace has been updated in another session; reload before saving"}

    monkeypatch.setattr(main_module, "update_business", lambda *_args: (_ for _ in ()).throw(LookupError("Business not found")))
    missing = client.put(f"/api/businesses/{bid}", json={**raw_fixture, "expected_revision": 1})
    assert missing.status_code == 404
    assert missing.json() == {"detail": "Business not found"}


@pytest.mark.skipif(not os.getenv("PERSISTENCE_TEST_URL"), reason="Requires migrated disposable PostgreSQL database")
def test_live_auth_sessions_and_owner_isolated_workspaces(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", os.environ["PERSISTENCE_TEST_URL"])
    get_engine.cache_clear()
    engine = get_engine()
    created_owners = []

    raw_fixture = json.loads((Path(__file__).parent / "fixtures/aster_components.json").read_text())["request"]
    for period in raw_fixture["periods"]:
        for figure in period["values"].values():
            figure["reviewed"] = True

    try:
        alice = TestClient(app)
        bob = TestClient(app)
        anon = TestClient(app)

        # Unauthenticated access is rejected on every protected route.
        assert anon.get("/api/auth/session").status_code == 401
        assert anon.get("/api/businesses").status_code == 401
        assert anon.post("/api/businesses", json=raw_fixture).status_code == 401
        assert anon.put(f"/api/businesses/{uuid4()}", json={**raw_fixture, "expected_revision": 1}).status_code == 401
        assert anon.get(f"/api/businesses/{uuid4()}").status_code == 401
        assert anon.post(f"/api/businesses/{uuid4()}/analysis").status_code == 401
        assert anon.get(f"/api/analysis-runs/{uuid4()}").status_code == 401

        # Register Alice and inspect session cookie & hashed DB storage.
        email_a = f"alice-{uuid4().hex[:8]}@example.com"
        reg_a = alice.post("/api/auth/register", json={"email": f"  {email_a.upper()} ", "password": "alice-password-123"})
        assert reg_a.status_code == 201
        owner_a = reg_a.json()["owner_id"]
        created_owners.append(owner_a)
        assert reg_a.json()["email"] == email_a
        token_a = alice.cookies.get(SESSION_COOKIE)
        assert token_a
        set_cookie_header = reg_a.headers.get("set-cookie", "").lower()
        assert "httponly" in set_cookie_header
        assert "samesite=lax" in set_cookie_header

        with engine.connect() as conn:
            acct = conn.execute(select(accounts).where(accounts.c.email == email_a)).mappings().one()
            assert acct["password_hash"].startswith("scrypt$")
            assert "alice-password-123" not in acct["password_hash"]
            sess = conn.execute(select(sessions).where(sessions.c.owner_id == acct["owner_id"])).mappings().one()
            assert sess["token_hash"] == _token_hash(token_a)
            assert sess["token_hash"] != token_a

        # Duplicate registration fails with 409 and does not overwrite account.
        dup = anon.post("/api/auth/register", json={"email": email_a, "password": "other-password-123"})
        assert dup.status_code == 409

        # Wrong password and unknown email return identical 401 responses.
        bad_pw = anon.post("/api/auth/login", json={"email": email_a, "password": "wrong-password-123"})
        bad_user = anon.post("/api/auth/login", json={"email": f"unknown-{uuid4().hex[:8]}@example.com", "password": "wrong-password-123"})
        assert bad_pw.status_code == 401
        assert bad_user.status_code == 401
        assert bad_pw.json() == bad_user.json() == {"detail": "Invalid email or password"}

        # Register Bob.
        email_b = f"bob-{uuid4().hex[:8]}@example.com"
        reg_b = bob.post("/api/auth/register", json={"email": email_b, "password": "bob-password-12345"})
        assert reg_b.status_code == 201
        created_owners.append(reg_b.json()["owner_id"])

        # Alice creates and analyses a workspace; client-supplied owner_id is rejected by strict schema.
        assert alice.post("/api/businesses", json={**raw_fixture, "owner_id": str(uuid4())}).status_code == 422
        created = alice.post("/api/businesses", json=raw_fixture)
        assert created.status_code == 201
        workspace = created.json()
        business_id = workspace["business_id"]
        assert workspace["input_revision"] == 1
        assert workspace["latest_analysis"] is None
        assert workspace["request"]["business_name"] == raw_fixture["business_name"]

        analysed = alice.post(f"/api/businesses/{business_id}/analysis")
        assert analysed.status_code == 201
        run_id = analysed.json()["latest_run_id"]
        assert run_id is not None
        assert analysed.json()["latest_analysis"]["periods"][1]["indicators"][0]["value"] == "20"
        assert analysed.json()["runs"] == [{
            "run_id": run_id,
            "input_revision": 1,
            "rule_version": "financial-rules-v1",
            "action_version": "preparation-actions-v1",
            "superseded": False,
            "created_at": analysed.json()["runs"][0]["created_at"],
        }]

        # Alice updates her workspace in place; stale revision returns 409 and prior run becomes superseded.
        corrected_fixture = json.loads(json.dumps(raw_fixture))
        corrected_fixture["periods"][1]["values"]["interest_expense"]["raw"] = "300000.00"
        updated = alice.put(f"/api/businesses/{business_id}", json={**corrected_fixture, "expected_revision": 1})
        assert updated.status_code == 200
        assert updated.json()["input_revision"] == 2
        assert updated.json()["latest_run_id"] is None
        assert updated.json()["latest_analysis"] is None
        assert updated.json()["request"]["periods"][1]["values"]["interest_expense"]["revision"] == 2
        assert updated.json()["request"]["periods"][1]["values"]["ebit"]["revision"] == 1
        assert updated.json()["runs"][0]["run_id"] == run_id
        assert updated.json()["runs"][0]["superseded"] is True

        stale = alice.put(f"/api/businesses/{business_id}", json={**corrected_fixture, "expected_revision": 1})
        assert stale.status_code == 409
        assert stale.json() == {"detail": "Workspace has been updated in another session; reload before saving"}

        reanalysed = alice.post(f"/api/businesses/{business_id}/analysis")
        assert reanalysed.status_code == 201
        run_id_2 = reanalysed.json()["latest_run_id"]
        assert run_id_2 != run_id
        assert reanalysed.json()["latest_analysis"]["periods"][1]["indicators"][5]["value"] == "4"
        assert [(r["run_id"], r["input_revision"], r["superseded"]) for r in reanalysed.json()["runs"]] == [
            (run_id_2, 2, False),
            (run_id, 1, True),
        ]

        # Alice lists and loads her workspace and analysis run.
        listed_a = alice.get("/api/businesses")
        assert listed_a.status_code == 200
        assert listed_a.json() == [{"id": business_id, "business_name": raw_fixture["business_name"], "input_revision": 2}]
        assert alice.get(f"/api/businesses/{business_id}").status_code == 200
        assert alice.get(f"/api/analysis-runs/{run_id}").status_code == 200
        assert alice.get(f"/api/analysis-runs/{run_id_2}").status_code == 200

        # Bob cannot see Alice's business in his list and receives identical 404s for Alice's IDs and unknown IDs.
        assert bob.get("/api/businesses").json() == []
        unknown_id = str(uuid4())
        for path in (f"/api/businesses/{business_id}", f"/api/businesses/{unknown_id}"):
            res_bob = bob.get(path)
            assert res_bob.status_code == 404
            assert res_bob.json() == {"detail": "Business not found"}
            for expected_rev in (1, 2):
                put_bob = bob.put(path, json={**raw_fixture, "expected_revision": expected_rev})
                assert put_bob.status_code == 404
                assert put_bob.json() == {"detail": "Business not found"}
        assert bob.post(f"/api/businesses/{business_id}/analysis").status_code == 404
        for path in (f"/api/analysis-runs/{run_id}", f"/api/analysis-runs/{run_id_2}", f"/api/analysis-runs/{unknown_id}"):
            res_run = bob.get(path)
            assert res_run.status_code == 404
            assert res_run.json() == {"detail": "Analysis not found"}

        # Expired session is rejected with 401.
        with engine.begin() as conn:
            conn.execute(
                sessions.update()
                .where(sessions.c.token_hash == _token_hash(token_a))
                .values(expires_at=datetime.now(timezone.utc) - timedelta(minutes=1))
            )
        assert alice.get("/api/auth/session").status_code == 401

        # Alice logs back in, then logs out; revoked session is rejected immediately.
        relogin = alice.post("/api/auth/login", json={"email": email_a, "password": "alice-password-123"})
        assert relogin.status_code == 200
        assert alice.get("/api/auth/session").status_code == 200
        assert alice.post("/api/auth/logout").status_code == 200
        assert alice.get("/api/auth/session").status_code == 401
    finally:
        with engine.begin() as conn:
            for owner_id in created_owners:
                conn.execute(businesses.delete().where(businesses.c.owner_id == owner_id))
                conn.execute(owners.delete().where(owners.c.id == owner_id))
        engine.dispose()
        get_engine.cache_clear()
