FROM python:3.14.8-slim-trixie
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HOME=/opt/huggingface
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
# Bake the embedding model into the image so retrieval runs offline (HF_HUB_OFFLINE below).
RUN python -c 'from sentence_transformers import SentenceTransformer; SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2", device="cpu")'
COPY alembic.ini ./
COPY migrations ./migrations
COPY app ./app
RUN useradd --system --uid 10001 --home-dir /app credlens \
    && mkdir -p /data/documents && chown credlens /data/documents
USER credlens
ENV PYTHON_DOTENV_DISABLED=1 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    DOCUMENT_STORAGE_DIR=/data/documents
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/api/health", timeout=4)'
# Migrations run before the server starts; only nginx on the compose network can reach this port,
# so trusting its forwarded headers is safe.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips '*'"]
