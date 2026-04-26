# scrollantir runtime — Python image for api + agent services.
# Two services in compose.yaml share this image; commands differ.

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    PATH="/app/.venv/bin:$PATH"

# uv binary (multi-stage copy from upstream)
COPY --from=ghcr.io/astral-sh/uv:0.11.2 /uv /usr/local/bin/uv

WORKDIR /app

# Dependency layer — cached when only src/ changes.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-editable

# Source.
COPY src/ ./src/
RUN uv sync --frozen --no-editable
