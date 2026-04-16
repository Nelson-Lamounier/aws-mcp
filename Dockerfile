# @format
# wiki-mcp Dockerfile
#
# Multi-stage build — matches Python 3.13 used in local .venv.
#
# Stage 1 (deps):   pip install into /install prefix
# Stage 2 (runner): minimal runtime, non-root uid 1001
#
# Build:
#   docker build -t wiki-mcp .
#
# Run locally (file mode):
#   docker run -p 8000:8000 \
#     -e WIKI_LOCAL_PATH=/kb \
#     -v /Users/nelsonlamounier/Desktop/portfolio/reasearch-brain/kowledge-base:/kb:ro \
#     wiki-mcp
#
# Run in K8s (S3 mode):
#   WIKI_S3_BUCKET and AWS creds come from EC2 Instance Profile (IMDS)

# ─────────────────────────────────────────────────────────────────────────────
# Stage 1 — Dependencies
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.13-slim AS deps

WORKDIR /install

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─────────────────────────────────────────────────────────────────────────────
# Stage 2 — Runtime
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.13-slim AS runner

# Non-root user — uid 1001 matches admin-api pattern in the cluster
RUN groupadd --gid 1001 wikimcp && \
    useradd  --uid 1001 --gid 1001 --no-create-home wikimcp

WORKDIR /app

# Copy installed packages and app code
COPY --from=deps /install /usr/local
COPY kb.py server.py ./

RUN chown -R wikimcp:wikimcp /app

USER wikimcp

EXPOSE 8000

# K8s health probe will hit /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz')"

ENV PYTHONUNBUFFERED=1

CMD ["python", "server.py"]
