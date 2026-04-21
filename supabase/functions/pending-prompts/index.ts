// GET /functions/v1/pending-prompts
// Phone polls this every 30s (or on screen-on). Returns all
// unanswered, undismissed, unexpired prompts in the system, gated by
// a valid bearer token. No device-level filtering — single-user
// system, phone is the only consumer.

import {
  Client,
  PostgresError,
} from "https://deno.land/x/postgres@v0.17.0/mod.ts";

const DB_URL = Deno.env.get("INGEST_DATABASE_URL");
if (!DB_URL) throw new Error("INGEST_DATABASE_URL secret not set");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET") return json(405, { error: "method_not_allowed" });

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return json(401, { error: "missing_bearer" });
  const token = auth.slice("Bearer ".length).trim();
  if (!token) return json(401, { error: "empty_bearer" });

  const client = new Client(DB_URL);
  await client.connect();

  try {
    const result = await client.queryObject<{
      id: string;
      kind: string;
      question: string;
      context: Record<string, unknown>;
      answer_schema: Record<string, unknown> | null;
      created_at: string;
      expires_at: string | null;
    }>({
      text: `SELECT * FROM ingest_api.pending_prompts($1::text)`,
      args: [token],
    });
    return json(200, { prompts: result.rows });
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 200);
    if (err instanceof PostgresError && err.fields.code === "28000") {
      return json(401, { error: "auth", reason: msg });
    }
    console.error({ level: "error", action: "pending_prompts", reason: msg });
    return json(500, { error: "internal", reason: msg });
  } finally {
    await client.end();
  }
});
