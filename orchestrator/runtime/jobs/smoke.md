# Smoke test

A trivial wiring check. The point is *only* to exercise the full
path: env vars set, DSN resolves, psql connects, Claude Code writes
one tiny report via the RPC.

## Steps

1. Confirm DB connect:

   ```
   psql "$AGENT_DATABASE_URL" -c "SELECT 1"
   ```

2. Write a one-line report tagged `['smoke']`:

   ```sql
   SELECT agent_api.upsert_report(
     NULL,
     'smoke ' || to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
     'ok',
     ARRAY['smoke'],
     NOW(),
     NOW()
   );
   ```

3. Print the new report id to stdout.

## If either step fails

Print the error and exit non-zero. Do not retry, do not improvise —
the smoke test's whole job is to be loud when plumbing is broken.
