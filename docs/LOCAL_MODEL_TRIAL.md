# P4-01: local instruction model and embedding feasibility report

Measured: 2026-11-20. Task: **P4-01**. Decision resolved: **D-04**.

This report records actual hardware, runtime, license, version, latency, memory, context-budget, and offline measurements for CredLens Phase 4. It does not add chat UI, retrieval tables, or runtime LLM calls to the application; those begin in **P4-02** and **P4-03**.

## Measured host and runtime environment

| Component | Measured value |
| --- | --- |
| Machine / OS | `Zephyrus-G14`, Ubuntu Linux `7.3.0-10-generic` (`x86_64`) |
| CPU | AMD Ryzen 9 7940HS (8 cores / 16 threads) |
| System RAM | `30 GiB` total (`~19 GiB` available before trial; `8.0 GiB` swap) |
| GPU / driver | NVIDIA GeForce RTX 4060 Laptop GPU, `8188 MiB` VRAM (`1776–1890 MiB` baseline desktop use), Compute Capability `8.9`, driver `615.71.09` (`>= 550` required by Ollama), CUDA `13.4` |
| Disk free | `391 GiB` available on `/` |
| Python | `3.14.8` in `backend/.venv` |
| Database extension | Neon PostgreSQL `vector` (`pgvector`) `0.8.7` available (`installed_version: null` until P4-02) |
| Ollama CLI / server | `v0.40.16` (MIT license; published `2026-11-09`, extracted from official `ollama-linux-amd64.tar.zst` to `~/.local/bin/ollama`, no `sudo`) |
| Embedding runtime | `sentence-transformers==6.3.0` (Apache-2.0) + `torch==2.15.0+cpu` (PyTorch CPU wheel index, `209.5 MB`), `transformers==5.23.0`, `tokenizers==0.23.3`, `huggingface-hub==2.4.0`, `safetensors==0.8.0`, `numpy==2.5.5`, `scipy==1.18.1`, `scikit-learn==1.9.1`; `pip check` clean against all existing backend pins |

## Selected local models and licenses (D-04)

| Role | Model | Digest / Revision | License | Size / Dimensions | Context / Sequence Limit |
| --- | --- | --- | --- | --- | --- |
| Local instruction model (Ollama) | `qwen3:4b-instruct` (`Q4_K_M`, 4.02B params, GGUF; refined from thinking-only `qwen3:4b` during live P4-04 verification) | `0edcdef34593` | Apache-2.0 | `2.5 GB` on disk (`3.2 GB` VRAM at `num_ctx=4096`) | Native `262,144`; configured **`num_ctx=4096`** (`100% GPU`) |
| Local embedding model (Sentence Transformers, CPU) | `sentence-transformers/all-MiniLM-L6-v2` | `1110a243fdf4` | Apache-2.0 | `90.9 MB` safetensors, **`384`** dimensions | **`256`** WordPiece tokens max (`model.max_seq_length = 256`) |

Why these models were chosen over alternatives checked online:
- `Qwen2.5-3B-Instruct` carries a custom `"other"` (Qwen Research) license on Hugging Face, whereas `qwen3:4b` is **Apache-2.0** and fits `100%` inside the RTX 4060's `8 GiB` VRAM without CPU spill.
- Running `all-MiniLM-L6-v2` on **CPU** (`torch==2.15.0+cpu`, `device="cpu"`) consumes `0 MiB` GPU VRAM so embeddings never compete with Ollama on an 8 GB GPU and behave identically on CPU-only teammate laptops.
- Cloud Ollama models (`:cloud`, `https://ollama.com`) are explicitly **excluded** to preserve CredLens's local-only processing and zero-paid-service constraints (`NFR02`).

## Measured performance and memory

### 1. Local embeddings (`all-MiniLM-L6-v2`, CPU, offline)

Verified with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1` and `SentenceTransformer(..., device="cpu", local_files_only=True)`:

| Metric | Measured result |
| --- | --- |
| Cold model load time (from local cache) | `0.095 s` |
| Batch embed (12 financial passage chunks, 70–91 tokens each) | `52.9 ms` (`4.4 ms/chunk`) |
| Single query embed (average of 5 runs) | `5.0 ms` (`min 4.5 ms`, `max 6.1 ms`) |
| Process RSS (before load / after load / peak) | `522.2 MiB` / `593.1 MiB` (`+70.9 MiB`) / `700.7 MiB` peak |
| GPU VRAM used | `0 MiB` |
| Retrieval sanity check (borrowing note query over 4 Aster chunks) | Top-1 exact match (`0.6168` vs. `0.3701`, `0.3171`, `0.1242`) |

**Retrieval chunking budget for P4-02:** Because `all-MiniLM-L6-v2` silently truncates inputs beyond `256` tokens, P4-02 chunks must be bounded to **`<= 220` tokens** (with tokenizer verification and overlap `<= 30` tokens), tagged with `(business_id, document_id, page_number, period/section)` metadata, and retrieve at most **`top_k = 6`** authorised passages per query.

### 2. Local instruction model (`qwen3:4b` on Ollama `v0.40.16`)

Verified against `http://127.0.0.1:11434/api/chat` with `options: { num_ctx: 4096, temperature: 0, seed: 42, num_predict: 1024 }`:

- **Critical `/api/show` finding:** Ollama's `qwen3:4b` (`359d7dd4bcda`) declares `thinking: {"values": [true], "default": true}`. Sending `"think": false` with a small `num_predict` (`256`) caused Ollama to ignore `think=false` and spill reasoning text into `message.content`. Sending **`"think": true`** with **`num_predict: 1024`** cleanly separates `message.thinking` from `message.content` (only `message.content` is returned to the user).

| Trial prompt (`think=True`, `num_ctx=4096`, `num_predict=1024`) | Wall latency | Total tokens / speed | Qualitative check |
| --- | --- | --- | --- |
| Cold load (first request from disk, prior run) | `21.60 s` load | `57.8 tok/s` | Loaded `100% GPU` (`3.2 GB` VRAM) |
| Warm 1: Net profit margin drop (9.00% → 5.00%) | `6.50 s` | `515 tok` (`80.7 tok/s`) | Exact numbers, cited `[p. 1]`, refused to invent cause |
| Warm 2: Missing interest expense (`Not assessed`) | `6.54 s` | `524 tok` (`81.3 tok/s`) | Named missing `interest expense`, cited `[p. 1]`, no invented ratio |
| Warm 3: Loan approval + prompt injection in `[p. 3]` note | `5.50 s` | `440 tok` (`81.2 tok/s`) | Ignored embedded injection, refused credit score and loan approval |

- **GPU memory during inference (`ollama ps` / `nvidia-smi`):** `qwen3:4b` allocated `3.2 GB` at `100% GPU` (`4934 / 8188 MiB` total GPU VRAM, `~3.05 GiB` delta over desktop baseline; released back to `1776 MiB` after shutdown).
- **Prompt context budget:** At `num_ctx = 4096`, the combined budget is: system instructions (`~200` tok) + reviewed calculation summary (`~400` tok) + up to `6` retrieved `220`-token chunks (`~1,320` tok) + question (`~100` tok) + `1,024` generated tokens (`~3,044` tok total, leaving `~1,050` tokens of headroom inside `4096`).

## Offline configuration and deterministic fallback policy

- **Ollama local-only settings:**
  - Start locally bound to loopback only: `OLLAMA_HOST=127.0.0.1:11434 ~/.local/bin/ollama serve`.
  - No `OLLAMA_API_KEY`, no `ollama signin`, and no `:cloud` model tags. Backend calls `http://127.0.0.1:11434/api/chat` strictly (configurable via `OLLAMA_BASE_URL`, rejecting non-loopback hosts by default).
- **Sentence Transformers offline settings:**
  - After initial cache download, run with `HF_HUB_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`, and `SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu", local_files_only=True)` so zero Hugging Face network requests occur during normal operation.
- **Unreachable / insufficient-hardware fallback (`NFR07-08`):**
  - When Ollama is stopped, unreachable (`ConnectError` measured fail-fast in `19.82 ms`), times out (`30 s` ceiling), or returns an invalid payload, CredLens falls back to a deterministic template response assembled directly from the Python calculation outputs, evidence states, preparation actions, and retrieved source citations—explicitly noting that the local explanation model is unavailable while keeping all reviewed calculations and citations usable.
  - On lower-memory / CPU-only machines where `qwen3:4b` is slow, `num_ctx` can be reduced to `2048` (with `top_k = 3`), or a smaller Apache-2.0 tag (`qwen3:1.7b`, `~1.4 GB`) or the deterministic template fallback can be selected via environment configuration without code changes.
