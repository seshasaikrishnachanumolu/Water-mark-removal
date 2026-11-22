# Single image: builds the React app, then serves it and the API from one FastAPI process.
#   docker build -t clearframe .
#   docker run -p 8000:8000 -v clearframe-data:/app/backend/storage clearframe
# AI extras (captions, AI background removal, LaMa) add ~1GB. Enable with:
#   docker build --build-arg WITH_AI=1 -t clearframe .

# ---- 1. frontend build ----
FROM node:20-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. runtime ----
FROM python:3.12-slim
ARG WITH_AI=0
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 FILE_TTL_HOURS=6 RATE_LIMIT_PER_MIN=120
WORKDIR /app/backend

COPY backend/requirements.txt backend/requirements-ai.txt ./
RUN pip install -r requirements.txt \
 && if [ "$WITH_AI" = "1" ]; then pip install -r requirements-ai.txt; fi

COPY backend/app ./app
# main.py serves ../frontend/dist when it exists.
COPY --from=web /web/dist /app/frontend/dist

# Run as an unprivileged user; storage/ and models/ are the only writable paths.
RUN useradd --create-home app && mkdir -p storage models && chown -R app /app
USER app
VOLUME ["/app/backend/storage", "/app/backend/models"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request as u; u.urlopen('http://127.0.0.1:8000/api/algorithms')" || exit 1
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
