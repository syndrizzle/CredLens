"""Explanation model client: the CredLens Workers AI proxy in `worker/` (D-09)."""

import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request as UrlRequest, build_opener

from app.settings import setting

DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_RESPONSE_BYTES = 256 * 1024
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


class ModelUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class ModelConfig:
    url: str
    token: str
    timeout_seconds: float


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# A redirect would resend the bearer token and the prompt somewhere else.
urlopen = build_opener(_NoRedirect()).open


def _read_model_config() -> ModelConfig:
    if setting("CREDLENS_AI_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        raise ModelUnavailableError("Explanation model is disabled by configuration.")

    url = setting("CREDLENS_AI_URL", "").strip()
    token = setting("CREDLENS_AI_TOKEN", "").strip()
    if not url or not token:
        raise ModelUnavailableError("Explanation model is not configured (CREDLENS_AI_URL and CREDLENS_AI_TOKEN).")
    try:
        parsed = urlparse(url)
        # HTTPS only, except plain HTTP to `wrangler dev` on this machine.
        allowed = parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in LOOPBACK_HOSTS)
    except ValueError:
        allowed = False
    if not allowed or not parsed.hostname:
        raise ModelUnavailableError("Explanation model URL must use HTTPS (or http://localhost for wrangler dev).")

    try:
        timeout = float(setting("CREDLENS_AI_TIMEOUT_SECONDS", str(DEFAULT_TIMEOUT_SECONDS)))
    except ValueError:
        timeout = DEFAULT_TIMEOUT_SECONDS
    return ModelConfig(url=url, token=token, timeout_seconds=max(1.0, min(120.0, timeout)))


def call_model(system_prompt: str, user_prompt: str) -> tuple[str, str]:
    """Send one system/user prompt pair to the Worker; returns `(model_name, content)`."""
    config = _read_model_config()
    req = UrlRequest(
        url=config.url,
        data=json.dumps({"system": system_prompt, "user": user_prompt}).encode("utf-8"),
        # Cloudflare rejects urllib's default User-Agent with HTTP 403.
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.token}",
            "User-Agent": "CredLens-backend",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=config.timeout_seconds) as resp:
            raw = resp.read(MAX_RESPONSE_BYTES + 1)
    except HTTPError as exc:
        raise ModelUnavailableError(f"Explanation model returned HTTP {exc.code}.") from exc
    except TimeoutError as exc:
        raise ModelUnavailableError("Explanation model timed out before completing a response.") from exc
    except (URLError, OSError) as exc:
        raise ModelUnavailableError("Explanation model is not reachable.") from exc
    if len(raw) > MAX_RESPONSE_BYTES:
        raise ModelUnavailableError("Explanation model returned an oversized response.")

    try:
        body = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise ModelUnavailableError("Explanation model returned an unreadable response.") from exc
    model = body.get("model") if isinstance(body, dict) else None
    content = body.get("content") if isinstance(body, dict) else None
    if not isinstance(model, str) or not isinstance(content, str) or not content.strip():
        raise ModelUnavailableError("Explanation model returned an empty answer.")
    return model, content.strip()
