# SIGHT backend. Works on Render, Railway, Fly.io, or any Docker host.
# Secrets are NOT baked in: set them as environment variables on the host (see docs/DEPLOY.md).
FROM python:3.14-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Dependencies first, so code changes don't reinstall them. constraints.txt pins the exact
# versions the app was tested with.
COPY requirements.txt constraints.txt ./
RUN pip install -r requirements.txt -c constraints.txt

COPY app ./app

# Run as a non-root user. /app stays writable for the SQLite fallback (use TiDB in production:
# most hosts wipe the container's disk on every deploy or restart).
RUN useradd --create-home --uid 10001 sight && chown -R sight /app
USER sight

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f'http://127.0.0.1:{os.environ.get(\"PORT\", \"8000\")}/health', timeout=4)"

# Exactly one worker, on purpose: live-mode scene state and AI-provider cooldowns live in memory,
# so several workers would each have their own copy and behave inconsistently.
# Hosts like Render set $PORT; it defaults to 8000 elsewhere.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1 --proxy-headers --forwarded-allow-ips '*'"]
