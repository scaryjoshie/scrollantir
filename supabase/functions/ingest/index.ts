// POST /functions/v1/ingest
// Thin Deno handler over ingest_api.accept_event. Connects as
// ingest_role (via INGEST_DATABASE_URL) and is the only internet-
// exposed write path for device events.
//
// Request body: one event object, or an array of them. Wire schema:
//   { id: uuid, device: text, source: text, timestamp: ISO8601,
//     duration_s: number, data?: object, schema_version?: number }
// (Wire field is `timestamp` — matches architecture.md and the
//  forwarders already ship this. We translate to p_timestamp_utc
//  when calling the RPC.)
//
// Per-event behavior:
//   - auth errors (SQLSTATE 28000: invalid token, device mismatch,
//     retired device) short-circuit the whole batch with 401.
//   - rate-limit errors (54000) short-circuit with 429 + Retry-After.
//   - per-event validation errors (bad timestamp, bad UUID, bad
//     device FK, check-constraint violation, or RPC-raised timestamp
//     bounds) record in errors[] and the batch continues.
//   - anything unexpected → abort batch with 500.
// All good events commit (ON CONFLICT DO NOTHING in the RPC), bad
// events appear in the `errors` array of the 200 response.

import {
  Client,
  PostgresError,
} from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const DB_URL = Deno.env.get("INGEST_DATABASE_URL");
if (!DB_URL) {
  throw new Error("INGEST_DATABASE_URL secret not set");
}

const MAX_BATCH = 2000;
const RETRY_AFTER_SECONDS = 60;

// Accept the standard UUID representation only. The Mac forwarder
// emits uuid5s and the Android app emits uuid4s; both land in this
// shape.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IngestEvent = {
  id?: unknown;
  device?: unknown;
  source?: unknown;
  timestamp?: unknown;
  duration_s?: unknown;
  data?: unknown;
  schema_version?: unknown;
};

type NormalizedEvent = {
  id: string;
  device: string;
  source: string;
  timestamp: string;
  duration_s: number;
  data: Record<string, unknown>;
  schema_version: number;
};

function json(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
  );
}

// Client-side shape check. If this passes, the RPC will only raise
// for business-rule reasons (auth, rate limit, timestamp bounds,
// ON CONFLICT DO NOTHING behavior). Catches the bugs that would
// otherwise come back as opaque 22P02/23514/etc. and get mapped to
// 500 by mistake.
function validate(e: IngestEvent): { ok: true; value: NormalizedEvent } | { ok: false; reason: string } {
  if (typeof e.id !== "string" || !UUID_RE.test(e.id)) {
    return { ok: false, reason: "id must be a UUID string" };
  }
  if (typeof e.device !== "string" || e.device.trim().length === 0) {
    return { ok: false, reason: "device must be a non-empty string" };
  }
  if (typeof e.source !== "string" || e.source.trim().length === 0) {
    return { ok: false, reason: "source must be a non-empty string" };
  }
  if (typeof e.timestamp !== "string" || Number.isNaN(Date.parse(e.timestamp))) {
    return { ok: false, reason: "timestamp must be ISO-8601 parseable" };
  }
  const duration_s = e.duration_s ?? 0;
  if (typeof duration_s !== "number" || !Number.isFinite(duration_s) || duration_s < 0) {
    return { ok: false, reason: "duration_s must be a finite non-negative number" };
  }
  const schema_version = e.schema_version ?? 1;
  if (
    typeof schema_version !== "number" ||
    !Number.isInteger(schema_version) ||
    schema_version < 1 ||
    schema_version > 32767
  ) {
    return { ok: false, reason: "schema_version must be an int in 1..32767" };
  }
  const data = e.data ?? {};
  if (!isPlainObject(data)) {
    return { ok: false, reason: "data must be a JSON object" };
  }
  return {
    ok: true,
    value: {
      id: e.id,
      device: e.device,
      source: e.source,
      timestamp: e.timestamp,
      duration_s,
      data,
      schema_version,
    },
  };
}

type Classified =
  | { kind: "auth"; reason: string }
  | { kind: "rate_limit"; reason: string }
  | { kind: "validation"; reason: string }
  | { kind: "internal"; reason: string };

function classifyPgError(err: unknown): Classified {
  const raw = String((err as Error)?.message ?? err);
  const reason = raw.slice(0, 200);

  // Preferred path: typed PostgresError from deno-postgres exposes
  // fields.code as the SQLSTATE. If somehow we get a different error
  // shape (driver change, non-pg error), fall through to `internal`
  // and alert via logs.
  if (err instanceof PostgresError) {
    const code = err.fields.code;
    if (code === "28000") return { kind: "auth", reason };
    if (code === "54000") return { kind: "rate_limit", reason };
    if (
      code === "22007" ||          // invalid_datetime_format
      code === "22P02" ||          // invalid_text_representation (bad UUID, etc)
      code === "23503" ||          // foreign_key_violation (unknown device_id)
      code === "23514"             // check_violation (source empty, etc)
    ) {
      return { kind: "validation", reason };
    }
    // Untagged exceptions raised by accept_event (timestamp bounds)
    // come through as generic raise_exception without a custom SQLSTATE.
    if (/timestamp too far/i.test(raw)) {
      return { kind: "validation", reason };
    }
    return { kind: "internal", reason };
  }

  // Not a PostgresError — probably a connection/driver issue.
  return { kind: "internal", reason };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return json(405, { error: "method_not_allowed" });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return json(401, { error: "missing_bearer" });
  }
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return json(401, { error: "empty_bearer" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  const raw: IngestEvent[] = Array.isArray(body)
    ? body
    : body && typeof body === "object"
    ? [body as IngestEvent]
    : [];

  if (raw.length === 0) return json(400, { error: "empty_batch" });
  if (raw.length > MAX_BATCH) {
    return json(413, { error: "batch_too_large", max: MAX_BATCH });
  }

  const client = new Client(DB_URL);
  await client.connect();

  const errors: Array<{ index: number; id?: string; reason: string }> = [];
  let accepted = 0;

  try {
    for (let i = 0; i < raw.length; i++) {
      const e = raw[i] ?? {};
      const v = validate(e);
      if (!v.ok) {
        errors.push({
          index: i,
          id: typeof e.id === "string" ? e.id : undefined,
          reason: v.reason,
        });
        continue;
      }
      const ev = v.value;

      try {
        await client.queryArray({
          text:
            `SELECT ingest_api.accept_event($1::text, $2::uuid, $3::text, $4::text, $5::timestamptz, $6::double precision, $7::jsonb, $8::smallint)`,
          args: [
            token,
            ev.id,
            ev.device,
            ev.source,
            ev.timestamp,
            ev.duration_s,
            JSON.stringify(ev.data),
            ev.schema_version,
          ],
        });
        accepted++;
      } catch (err) {
        const m = classifyPgError(err);
        if (m.kind === "auth") {
          return json(401, { error: "auth", reason: m.reason });
        }
        if (m.kind === "rate_limit") {
          return json(
            429,
            { error: "rate_limited", reason: m.reason },
            { "Retry-After": String(RETRY_AFTER_SECONDS) },
          );
        }
        if (m.kind === "internal") {
          console.error("accept_event internal error", {
            index: i,
            reason: m.reason,
          });
          return json(500, { error: "internal", reason: m.reason });
        }
        // validation: per-event, continue batch
        errors.push({ index: i, id: ev.id, reason: m.reason });
      }
    }
  } finally {
    await client.end();
  }

  console.log({ level: "info", accepted, rejected: errors.length });

  return json(200, {
    ok: errors.length === 0,
    accepted,
    rejected: errors.length,
    errors,
  });
});
