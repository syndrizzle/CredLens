from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import secrets
from uuid import UUID, uuid4

from sqlalchemy import select
from sqlalchemy.engine import Connection
from sqlalchemy.exc import IntegrityError

from app.models import accounts, owners, sessions
from app.schemas import SessionResponse

SESSION_COOKIE = "credlens_session"
SESSION_MAX_AGE = 7 * 24 * 60 * 60
SCRYPT_N, SCRYPT_R, SCRYPT_P, SCRYPT_DKLEN = 16384, 8, 1, 32


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = secrets.token_bytes(16) if salt is None else salt
    digest = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=SCRYPT_DKLEN)
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}"


DUMMY_HASH = hash_password("dummy-password-for-timing", b"0123456789abcdef")


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        scheme, n, r, p, salt_hex, digest_hex = stored_hash.split("$")
        if scheme != "scrypt":
            return False
        actual = hashlib.scrypt(
            password.encode(), salt=bytes.fromhex(salt_hex),
            n=int(n), r=int(r), p=int(p), dklen=len(bytes.fromhex(digest_hex)),
        )
        return hmac.compare_digest(actual, bytes.fromhex(digest_hex))
    except (ValueError, TypeError):
        return False


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _create_session(connection: Connection, owner_id: UUID) -> str:
    token = secrets.token_urlsafe(32)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=SESSION_MAX_AGE)
    connection.execute(sessions.insert().values(
        token_hash=_token_hash(token), owner_id=owner_id, expires_at=expires_at,
    ))
    return token


def register_account(connection: Connection, email: str, password: str) -> tuple[SessionResponse, str]:
    normalized = email.strip().lower()
    owner_id = uuid4()
    connection.execute(owners.insert().values(id=owner_id))
    try:
        connection.execute(accounts.insert().values(
            owner_id=owner_id, email=normalized, password_hash=hash_password(password),
        ))
    except IntegrityError:
        raise ValueError("Account already exists") from None
    return SessionResponse(owner_id=owner_id, email=normalized), _create_session(connection, owner_id)


def authenticate_account(connection: Connection, email: str, password: str) -> tuple[SessionResponse, str]:
    normalized = email.strip().lower()
    row = connection.execute(select(accounts).where(accounts.c.email == normalized)).mappings().one_or_none()
    if row is None:
        verify_password(password, DUMMY_HASH)
        raise PermissionError("Invalid email or password")
    if not verify_password(password, row["password_hash"]):
        raise PermissionError("Invalid email or password")
    return SessionResponse(owner_id=row["owner_id"], email=row["email"]), _create_session(connection, row["owner_id"])


def resolve_session(connection: Connection, token: str | None) -> SessionResponse:
    if not token:
        raise PermissionError("Authentication required")
    now = datetime.now(timezone.utc)
    row = connection.execute(
        select(sessions.c.owner_id, accounts.c.email)
        .join(accounts, accounts.c.owner_id == sessions.c.owner_id)
        .where(sessions.c.token_hash == _token_hash(token), sessions.c.expires_at > now)
    ).mappings().one_or_none()
    if row is None:
        raise PermissionError("Authentication required")
    return SessionResponse(owner_id=row["owner_id"], email=row["email"])


def revoke_session(connection: Connection, token: str | None) -> None:
    if token:
        connection.execute(sessions.delete().where(sessions.c.token_hash == _token_hash(token)))
