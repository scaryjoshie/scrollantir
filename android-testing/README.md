# Stub ingest server

A placeholder for the real ingest server, used during Stage 3–4 LAN testing.

## Run

One-liner with `uv` (recommended):

```bash
uv run --with fastapi --with uvicorn --with pydantic python server.py
```

Or with stock Python:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

By default listens on `0.0.0.0:8000`, token `dev-token`. Override with:

```bash
SCROLLANTIR_TOKEN=my-secret python server.py
```

## Find your Mac's LAN IP

```bash
ipconfig getifaddr en0   # Wi-Fi on most Macs
```

That's the URL to put into the Android app's Server field: `http://<that-ip>:8000`.

## Received data

Each POST is logged to stdout (you'll see batches arrive in real time) and
appended to `received/YYYY-MM-DD.jsonl` for later inspection.

## What this is NOT

- No database — just a file log
- No dedup on client_id — duplicates will show up as extra log lines, which
  is useful during testing to verify the forwarder deletes on ack
- No rate limit
- No HTTPS — LAN only, the Android app has `usesCleartextTraffic=true` for
  this reason. Do not expose this server publicly.
