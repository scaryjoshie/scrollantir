// POST /functions/v1/prompt-answer
// Thin Deno handler over ingest_api.accept_prompt_answer. The phone
// calls this when the user answers an agent-posted prompt. The RPC
// atomically (a) inserts the answer as an event with source
// 'prompt.<kind>' and (b) marks the prompt answered — both in one
// transaction.
//
// Request body: { prompt_id: UUID, answer_event_id: UUID, data: object }

import {
  Client,
  PostgresError,
} from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const DB_URL = Deno.env.get("INGEST_DATABASE_URL");
if (!DB_URL) throw new Error("INGEST_DATABASE_URL secret not set");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "missing_bearer" });
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return json(401, { error: "empty_bearer" });

  let body: { prompt_id?: string; answer_event_id?: string; data?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "bad_json" });
  }

  if (!body.prompt_id || !body.answer_event_id) {
    return json(400, { error: "missing_prompt_id_or_answer_event_id" });
  }
  if (!UUID_RE.test(body.prompt_id) || !UUID_RE.test(body.answer_event_id)) {
    return json(400, { error: "prompt_id_and_answer_event_id_must_be_uuids" });
  }
  if (body.data !== undefined && !(body.data && typeof body.data === "object" && !Array.isArray(body.data))) {
    return json(400, { error: "data_must_be_object" });
  }

  const client = new Client(DB_URL);
  await client.connect();

  try {
    const result = await client.queryObject<{ accept_prompt_answer: string }>({
      text:
        `SELECT ingest_api.accept_prompt_answer($1::text, $2::uuid, $3::uuid, $4::jsonb) AS accept_prompt_answer`,
      args: [
        token,
        body.prompt_id,
        body.answer_event_id,
        JSON.stringify(body.data ?? {}),
      ],
    });
    const event_id = result.rows[0]?.accept_prompt_answer;
    console.log({ level: "info", action: "prompt_answer" });
    return json(200, { ok: true, event_id });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 200);

    if (err instanceof PostgresError) {
      const code = err.fields.code;
      if (code === "28000") return json(401, { error: "auth", reason: msg });
      if (code === "23505") {
        // UUID collision on answer_event_id — caller should mint a
        // fresh UUID and retry.
        return json(409, { error: "answer_event_id_conflict", reason: msg });
      }
      if (code === "22P02" || code === "22007") {
        return json(400, { error: "bad_param_format", reason: msg });
      }
      // The RPC raises an untagged exception for "prompt not answerable"
      // (missing, already answered, dismissed, expired). Brittle regex;
      // a schema change to give this raise a dedicated SQLSTATE would
      // be the proper fix.
      if (/prompt not answerable/i.test(msg)) {
        return json(409, { error: "prompt_not_answerable", reason: msg });
      }
    }
    console.error({ level: "error", action: "prompt_answer", reason: msg });
    return json(500, { error: "internal", reason: msg });
  } finally {
    await client.end();
  }
});
