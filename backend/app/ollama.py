"""Local Ollama configuration and transport."""

import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request as UrlRequest, build_opener

from app.settings import setting

DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434"
DEFAULT_OLLAMA_MODEL = "qwen3:4b-instruct"
DEFAULT_OLLAMA_NUM_CTX = 4096
DEFAULT_OLLAMA_NUM_PREDICT = 1024
DEFAULT_OLLAMA_TIMEOUT_SECONDS = 30.0
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

class OllamaUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True)
class OllamaConfig:
    base_url: str
    model: str
    num_ctx: int
    num_predict: int
    timeout_seconds: float


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


# Keep loopback requests local even when the host configures an HTTP proxy.
urlopen = build_opener(ProxyHandler({}), _NoRedirect()).open


def _read_ollama_config() -> OllamaConfig:
    if setting("OLLAMA_DISABLED", "").strip().lower() in {"1", "true", "yes"}:
        raise OllamaUnavailableError("Local explanation model is disabled by configuration.")

    base_url = setting("OLLAMA_BASE_URL", DEFAULT_OLLAMA_BASE_URL).strip().rstrip("/")
    try:
        parsed = urlparse(base_url)
        local = parsed.scheme == "http" and parsed.hostname in LOOPBACK_HOSTS
    except ValueError:
        local = False
    if not local:
        raise OllamaUnavailableError(
            "Local explanation model URL must use loopback http://127.0.0.1 or http://localhost."
        )

    model = setting("OLLAMA_MODEL", DEFAULT_OLLAMA_MODEL).strip()
    lowered_model = model.lower()
    if (
        not model
        or ":cloud" in lowered_model
        or "-cloud" in lowered_model
        or "ollama.com" in lowered_model
    ):
        raise OllamaUnavailableError("Cloud Ollama model tags are disabled; use a local model.")

    def _bounded_int(env_key: str, default: int, lo: int, hi: int) -> int:
        raw = setting(env_key)
        if not raw:
            return default
        try:
            val = int(raw)
        except ValueError:
            return default
        return max(lo, min(hi, val))

    try:
        timeout = float(setting("OLLAMA_TIMEOUT_SECONDS", str(DEFAULT_OLLAMA_TIMEOUT_SECONDS)))
    except ValueError:
        timeout = DEFAULT_OLLAMA_TIMEOUT_SECONDS
    timeout = max(1.0, min(120.0, timeout))

    return OllamaConfig(
        base_url=base_url,
        model=model,
        num_ctx=_bounded_int("OLLAMA_NUM_CTX", DEFAULT_OLLAMA_NUM_CTX, 1024, 8192),
        num_predict=_bounded_int("OLLAMA_NUM_PREDICT", DEFAULT_OLLAMA_NUM_PREDICT, 128, 2048),
        timeout_seconds=timeout,
    )


def call_local_ollama(system_prompt: str, user_prompt: str) -> tuple[str, str]:
    """Call local loopback Ollama `/api/chat` with D-04 settings; returns `(model_name, content)`."""
    config = _read_ollama_config()
    payload: dict = {
        "model": config.model,
        "stream": False,
        "options": {
            "num_ctx": config.num_ctx,
            "temperature": 0,
            "seed": 42,
            "num_predict": config.num_predict,
        },
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
    }
    if "instruct" not in config.model.lower():
        payload["think"] = True
    req = UrlRequest(
        url=f"{config.base_url}/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(req, timeout=config.timeout_seconds) as resp:
            if getattr(resp, "status", 200) != 200:
                raise OllamaUnavailableError(
                    f"Local explanation model returned HTTP {getattr(resp, 'status', 'error')}."
                )
            raw = resp.read()
    except HTTPError as exc:
        raise OllamaUnavailableError(
            f"Local explanation model returned HTTP {exc.code}."
        ) from exc
    except TimeoutError as exc:
        raise OllamaUnavailableError(
            "Local explanation model timed out before completing a response."
        ) from exc
    except (URLError, OSError) as exc:
        raise OllamaUnavailableError(
            "Local explanation model (Ollama) is not reachable at the configured loopback address."
        ) from exc

    try:
        body = json.loads(raw.decode("utf-8"))
    except ValueError as exc:
        raise OllamaUnavailableError(
            "Local explanation model returned an unreadable response."
        ) from exc

    if not isinstance(body, dict) or not isinstance(body.get("message"), dict):
        raise OllamaUnavailableError(
            "Local explanation model returned an incomplete payload."
        )
    content = body["message"].get("content")
    if not isinstance(content, str) or not content.strip():
        raise OllamaUnavailableError(
            "Local explanation model returned an empty answer."
        )
    return config.model, content.strip()
