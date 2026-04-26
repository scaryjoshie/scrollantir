# Scrollantir — Supabase Edge Functions spec

TypeScript running on Deno, hosted on Supabase. The only
internet-exposed surface for writes. Each function is a thin RPC
caller — all real logic lives in `ingest_api.*` / `agent_api.*`
SECURITY DEFINER functions in the database.

## What ships as an edge function (and what doesn't)

Three edge functions are deployed and live (since 2026-04-21):

- `/functions/v1/ingest` — device → events POST
- `/functions/v1/prompt-answer` — phone → answer POST
- `/functions/v1/pending-prompts` — phone → unanswered prompts GET

The "Function 4–6" sections below (`daily-digest`, `weekly-report`,
`token-cleanup`) were originally specced as edge functions but
**didn't ship that way**. Edge functions are short-lived, stateless
Deno workers with no persistent FS — wrong shape for an agent that
needs accumulated skills/memory and longer reasoning windows. Those
jobs moved to the **orchestrator container** (Hetzner CAX11 + systemd
+ Docker + cron, see `orchestrator.md`):

- `daily-digest` — orchestrator cron `0 7 * * *`
- `weekly-report` — orchestrator cron `0 9 * * 0`
- `classifier` — orchestrator cron (deferred until roadmap #8)
- `token-cleanup` — pure SQL pg_cron in Postgres (still planned;
  doesn't need an edge function or the orchestrator since it has no
  LLM step)

The spec sections below are kept as reference for the original design;
when reading them, treat anything past Function 3 as "this is what
moved to the orchestrator instead."

## File layout

```
supabase/
└── functions/
    ├── ingest/              # POST /functions/v1/ingest
    │   ├── index.ts
    │   └── deno.json
    ├── prompt-answer/       # POST /functions/v1/prompt-answer
    │   ├── index.ts
    │   └── deno.json
    ├── pending-prompts/     # GET  /functions/v1/pending-prompts
    │   ├── index.ts
    │   └── deno.json
    ├── daily-digest/        # cron-fired; see scheduled section
    │   ├── index.ts
    │   └── deno.json
    └── _shared/             # shared utilities (optional)
        ├── db.ts            # postgres client wrapper
        └── cors.ts          # CORS headers if needed
```

Each function has its own `deno.json` specifying import map + compile target. Keep dependencies minimal — `postgres` from `https://deno.land/x/postgres`, nothing heavier.

## Deployment

```bash
supabase functions deploy ingest
supabase functions deploy prompt-answer
supabase functions deploy pending-prompts
# later:
supabase functions deploy daily-digest
```

## Secrets

Set once with:

```bash
supabase secrets set INGEST_DATABASE_URL='postgresql://ingest_role:...'
supabase secrets set ANTHROPIC_API_KEY='sk-ant-...'    # when we add scheduled agents
supabase secrets set GROQ_API_KEY='gsk_...'            # optional: fast classifier
```

Inside functions: `Deno.env.get("INGEST_DATABASE_URL")`.

**Critical:** the ingest function must connect as `ingest_role`, NOT
`service_role`. If the function's key is ever compromised, the blast
radius is limited to "can call `ingest_api.accept_event` / `accept_prompt_answer` /
`pending_prompts`" — cannot SELECT anything, cannot touch tokens or
derived tables.

## Function 1: `ingest/index.ts`

```typescript
import { serve } from "https://deno.land/std/http/server.ts";
import { Client } from "https://deno.land/x/postgres/mod.ts";

const DB_URL = Deno.env.get("INGEST_DATABASE_URL")!;

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "missing bearer" }), { status: 401 });
  }
  const token = auth.slice(7);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400 });
  }

  // Accept either a single event or an array.
  const events = Array.isArray(body) ? body : [body];
  if (events.length > 2000) {
    return new Response(JSON.stringify({ error: "batch too large" }), { status: 413 });
  }

  const client = new Client(DB_URL);
  await client.connect();
  let ok = 0, errors: Array<{ index: number; message: string }> = [];
  try {
    for (let i = 0; i < events.length; i++) {
      const e = events[i] as Record<string, unknown>;
      try {
        await client.queryArray({
          text: `SELECT ingest_api.accept_event($1, $2, $3, $4, $5, $6, $7, $8)`,
          args: [
            token,
            e.id,
            e.device,
            e.source,
            e.timestamp,
            e.duration_s ?? 0,
            JSON.stringify(e.data ?? {}),
            e.schema_version ?? 1,
          ],
        });
        ok++;
      } catch (err) {
        errors.push({ index: i, message: String(err).slice(0, 200) });
      }
    }
  } finally {
    await client.end();
  }

  // Any error → respond with it. Partial success still returns 200
  // with a count, mirroring the forwarder's retry-idempotent model.
  return new Response(
    JSON.stringify({ ok: errors.length === 0, count: ok, errors }),
    {
      status: errors.length === 0 ? 200 : 207,
      headers: { "Content-Type": "application/json" },
    },
  );
});
```

Notes:
- Per-event try/catch so one bad event doesn't fail the whole batch.
- `accept_event` raises for auth, rate limit, or validation; caught and reported per-event.
- 207 Multi-Status for partial batches — forwarders inspect `errors[]` and advance their checkpoint past the `ok` events only. (Current Mac + Android forwarders don't yet handle 207; they expect 200/4xx/5xx. Update them to treat 207 as "some events landed, some didn't; retry the failing ones." — see `docs/roadmap.md` implementation notes.)

**Alternative (simpler):** fail the whole batch on the first error with 400/401/etc. Forwarder retries whole batch. Loses partial-success efficiency but simpler on both ends. Probably fine for personal project volume. **Default to this unless batch failure rates become visible.**

## Function 2: `prompt-answer/index.ts`

POST body: `{ prompt_id: UUID, answer_event_id: UUID, data: object }`.

Calls `ingest_api.accept_prompt_answer(token, prompt_id, answer_event_id, data)`. Returns `{ok: true, event_id: ...}` on success, 401/400/409 as appropriate.

Same auth pattern as `ingest`. Same `INGEST_DATABASE_URL` env var.

## Function 3: `pending-prompts/index.ts`

GET, `Authorization: Bearer <token>`.

Calls `ingest_api.pending_prompts(token)`. Returns `{prompts: [{id, kind, question, context, answer_schema, created_at, expires_at}, ...]}`.

Phone polls this every 30s (or on screen-on) and displays any returned prompts in the Questions inbox.

## Function 4: `daily-digest/index.ts` (scheduled)

Runs via `pg_cron` at 7am UTC. Fetches last 24h of events from the DB using a read-only connection (can use a dedicated `digest_role` or reuse `agent_role`), summarizes via Anthropic API, inserts a row into `public.reports` via `agent_api.upsert_report`.

```typescript
import { serve } from "https://deno.land/std/http/server.ts";
import Anthropic from "npm:@anthropic-ai/sdk";

// … fetch last 24h events via pg query
// … call Anthropic with a prompt "summarize this day of activity"
// … insert result via agent_api.upsert_report

serve(async (req) => {
  // pg_net calls with no body; auth via header if we want
  // (pg_cron can pass a secret header; validate here)
  // …
  return new Response(JSON.stringify({ ok: true, report_id: "..." }));
});
```

Cron job declared in a manual migration:

```sql
SELECT cron.schedule(
  'daily-digest',
  '0 7 * * *',
  $$SELECT net.http_post(
    url := 'https://feijpewzqgqczkxmvdng.supabase.co/functions/v1/daily-digest',
    headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.cron_secret'))
  )$$
);
```

`app.cron_secret` set once via `ALTER DATABASE postgres SET app.cron_secret = '<random>'`.

## Function 5: `weekly-report/index.ts` (scheduled)

Sunday 9am UTC. Similar to daily-digest but 7-day window, deeper analysis, stored in `reports` with tag `weekly-summary`.

## Function 6: `token-cleanup/index.ts` (scheduled)

Hourly. Revokes superseded tokens older than 48h; deletes old `ingest_rate_limit` rows.

Doesn't need external API. Pure SQL:

```sql
UPDATE private.tokens
   SET revoked_at = NOW()
 WHERE superseded_at IS NOT NULL
   AND revoked_at IS NULL
   AND superseded_at < NOW() - INTERVAL '48 hours';

DELETE FROM private.ingest_rate_limit
 WHERE window_start < NOW() - INTERVAL '1 hour';
```

Could be a pure `cron.schedule(..., '<sql>')` — no edge function needed. Save the 60s cold-start for things that actually need JavaScript.

## Logging

Supabase captures `console.log` / `console.error` from edge functions into the dashboard's Logs tab. **Never log the bearer token or full event data.** Acceptable to log:
- `{level: 'info', count: 42}` — batch landed
- `{level: 'warn', prefix: 'a3f891e2', reason: 'rate_limit'}` — rate-limited a specific prefix
- `{level: 'error', message: '...'}` — database errors

## Local testing

```bash
supabase functions serve ingest
# ...in another terminal:
curl -X POST http://localhost:54321/functions/v1/ingest \
  -H "Authorization: Bearer <test-token>" \
  -H "Content-Type: application/json" \
  -d '[{"id":"...", "device":"mac", "source":"test.ping", "timestamp":"2026-04-20T12:00:00Z", "duration_s":0, "data":{}}]'
```

For local testing, you need a local Supabase running (`supabase start`) OR set `INGEST_DATABASE_URL` to a dev branch of your real project.

## Acceptance

1. Deploy `ingest`, `prompt-answer`, `pending-prompts`.
2. Mint a dev token via `admin mint --device-id mac`.
3. `curl -X POST .../ingest` with a sample event — returns 200, event appears in `events` table.
4. Revoke the token, repeat — returns 401.
5. Send malformed JSON — returns 400.
6. Send 3000 events at once — returns 413.
7. Spam 300 requests in a minute with a valid token — some rejected with rate limit error.

## Related

- `docs/supabase.md` — function signatures for `ingest_api.*`
- `docs/admin-cli.md` — how tokens get minted
- `docs/roadmap.md` — #2 after admin CLI
