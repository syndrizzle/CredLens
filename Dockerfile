# One image: Bun builds the SPA, then FastAPI serves it and the API on port 8000.
# Traefik (with the Cloudflare origin certificate) routes the domain straight here.
FROM oven/bun:1.4.4 AS frontend
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.html vite.config.ts tsconfig.json tsconfig.app.json tsconfig.node.json components.json ./
COPY public ./public
COPY src ./src
RUN bun run build

FROM python:3.14.8-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/huggingface
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install -r requirements.txt
# Bake the embedding model into the image so retrieval runs offline (HF_HUB_OFFLINE below).
RUN python -c 'from sentence_transformers import SentenceTransformer; SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu")'
COPY backend/alembic.ini ./
COPY backend/migrations ./migrations
COPY backend/app ./app
COPY --from=frontend /app/dist ./static
RUN useradd --system --uid 10001 --home-dir /app credlens \
    && mkdir -p /data/documents && chown credlens /data/documents
USER credlens
ENV PYTHON_DOTENV_DISABLED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCUMENT_STORAGE_DIR=/data/documents \
    FRONTEND_DIST=/app/static
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=4)'
# Migrations run before the server starts. Forwarded headers come from Traefik on the Docker network.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
