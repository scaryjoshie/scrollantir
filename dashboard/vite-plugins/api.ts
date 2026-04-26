import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import postgres from 'postgres';
import { buildBlocks } from '../server/blocks';
import { summarize } from '../server/summarize';
import type { EventRow } from '../server/types';

type Sql = ReturnType<typeof postgres>;

export function apiPlugin(): Plugin {
  let sql: Sql | null = null;
  let sqlErr: string | null = null;

  const initSql = () => {
    const dsn = process.env.DATABASE_URL;
    if (!dsn) {
      sqlErr = 'DATABASE_URL not set; run `source scripts/load-dsn.sh` first.';
      return;
    }
    try {
      sql = postgres(dsn, {
        ssl: 'require',
        max: 3,
        idle_timeout: 20,
        connect_timeout: 10,
      });
    } catch (err) {
      sqlErr = `failed to init postgres client: ${String(err)}`;
    }
  };

  async function fetchEvents(sql: Sql, from: string, to: string): Promise<EventRow[]> {
    return (await sql`
      SELECT id,
             device,
             device_label,
             source,
             timestamp_utc,
             duration_s,
             data,
             tags
      FROM public.events_enriched
      WHERE timestamp_utc >= ${from}::timestamptz
        AND timestamp_utc <  ${to}::timestamptz
      ORDER BY device, source, timestamp_utc
    `) as unknown as EventRow[];
  }

  return {
    name: 'scrollantir-api',
    configureServer(server: ViteDevServer) {
      initSql();
      if (sqlErr) server.config.logger.warn(`[api] ${sqlErr}`);

      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();
        if (!sql) return fail(res, 503, sqlErr ?? 'db unavailable');

        try {
          const url = new URL(req.url, 'http://localhost');

          if (url.pathname === '/api/health') {
            const [{ now }] = await sql`SELECT NOW() AS now`;
            return json(res, { ok: true, now });
          }

          if (url.pathname === '/api/reports') {
            const limit = clamp(parseInt(url.searchParams.get('limit') ?? '50', 10), 1, 200);
            const rows = await sql`
              SELECT id, title, body, tags, window_start, window_end, created_at
              FROM public.reports
              WHERE deleted_at IS NULL
              ORDER BY created_at DESC
              LIMIT ${limit}
            `;
            return json(res, rows);
          }

          if (url.pathname === '/api/blocks' || url.pathname === '/api/summary') {
            const from = url.searchParams.get('from');
            const to = url.searchParams.get('to');
            if (!from || !to) return fail(res, 400, 'from & to required (ISO timestamps)');

            const events = await fetchEvents(sql, from, to);

            if (url.pathname === '/api/blocks') {
              const hideParam = url.searchParams.get('hide') ?? '';
              const hide = new Set(hideParam.split(',').map((s) => s.trim()).filter(Boolean));
              const filtered = hide.size ? events.filter((r) => !hide.has(r.source)) : events;
              const blocks = buildBlocks(filtered);
              return json(res, {
                blocks,
                stats: {
                  events_total: events.length,
                  events_kept: filtered.length,
                  blocks: blocks.length,
                },
              });
            }

            const wStart = Date.parse(from);
            const wEnd = Date.parse(to);
            const summary = summarize(events, wStart, wEnd);
            return json(res, summary);
          }

          return fail(res, 404, 'not found');
        } catch (err) {
          console.error('[api] error', err);
          return fail(res, 500, String((err as Error)?.message ?? err));
        }
      });
    },
    async closeBundle() {
      if (sql) await sql.end({ timeout: 2 });
    },
  };
}

function json(res: ServerResponse<IncomingMessage>, data: unknown) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function fail(res: ServerResponse<IncomingMessage>, status: number, msg: string) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: msg }));
}

function clamp(n: number, lo: number, hi: number) {
  if (Number.isNaN(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}
