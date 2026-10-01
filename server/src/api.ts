import type { FastifyInstance, FastifyReply } from 'fastify';
import { connectionStatus } from './auth.js';
import { config } from './config.js';
import { DATA_TYPES, DATA_TYPES_BY_ID } from './dataTypes.js';
import { allSyncState, countsByType, lastSyncRun, queryDataPoints, type DataPointRow } from './db.js';
import { currentSync, startSync } from './sync.js';

const MAX_LIMIT = 1000;

interface RangeQuery {
  from?: string;
  to?: string;
  limit?: string;
  offset?: string;
}

function requireType(type: string, reply: FastifyReply) {
  if (!DATA_TYPES_BY_ID.has(type)) {
    reply.code(404).send({ error: `Unknown data type: ${type}` });
    return false;
  }
  return true;
}

const toApiPoint = (r: DataPointRow) => ({
  name: r.name,
  dataType: r.data_type,
  startTime: r.start_time,
  endTime: r.end_time,
  syncedAt: r.synced_at,
  data: JSON.parse(r.raw_json),
});

/** Flattens nested objects into dot-separated keys for CSV columns. */
function flatten(obj: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = Array.isArray(obj) ? JSON.stringify(obj) : obj;
  }
  return out;
}

function toCsv(rows: Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))].join('\n');
}

export async function apiRoutes(app: FastifyInstance) {
  app.get('/api/status', async () => {
    const counts = countsByType();
    const state = new Map(allSyncState().map((s) => [s.data_type, s]));
    const running = currentSync();
    return {
      connection: connectionStatus(),
      backfillDays: config.backfillDays,
      sync: running ?? null,
      lastRun: (() => {
        const run = lastSyncRun();
        return run ? { ...run, details: run.details_json ? JSON.parse(run.details_json) : null } : null;
      })(),
      types: DATA_TYPES.map((t) => ({
        id: t.id,
        label: t.label,
        group: t.group,
        kind: t.kind,
        count: counts[t.id]?.count ?? 0,
        first: counts[t.id]?.first ?? null,
        last: counts[t.id]?.last ?? null,
        cursor: state.get(t.id)?.cursor ?? null,
        lastSyncedAt: state.get(t.id)?.last_synced_at ?? null,
        lastError: state.get(t.id)?.last_error ?? null,
      })),
    };
  });

  app.post<{ Body: { types?: string[]; from?: string } | null }>('/api/sync', async (req, reply) => {
    if (!connectionStatus().connected) {
      return reply.code(409).send({ error: 'Not connected. Connect your Google account first.' });
    }
    try {
      return reply.code(202).send(startSync(req.log, req.body ?? {}));
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get<{ Params: { type: string }; Querystring: RangeQuery }>('/api/data/:type', async (req, reply) => {
    if (!requireType(req.params.type, reply)) return;
    const limit = Math.min(MAX_LIMIT, Number(req.query.limit ?? 50));
    const offset = Number(req.query.offset ?? 0);
    const { total, rows } = queryDataPoints({
      dataType: req.params.type,
      from: req.query.from,
      to: req.query.to,
      limit,
      offset,
    });
    return { total, limit, offset, items: rows.map(toApiPoint) };
  });

  app.get<{ Params: { file: string }; Querystring: RangeQuery }>('/api/export/:file', async (req, reply) => {
    const match = /^(.+)\.(json|csv)$/.exec(req.params.file);
    if (!match) return reply.code(400).send({ error: 'Use /api/export/<type>.json or /api/export/<type>.csv' });
    const [, type, format] = match;
    if (!requireType(type, reply)) return;

    const { rows } = queryDataPoints({ dataType: type, from: req.query.from, to: req.query.to });
    const points = rows.map(toApiPoint);
    reply.header('Content-Disposition', `attachment; filename="${type}.${format}"`);
    if (format === 'json') {
      return reply.type('application/json').send(JSON.stringify(points, null, 2));
    }
    const flat = points.map(({ data, ...meta }) => ({ ...meta, ...flatten(data) }));
    return reply.type('text/csv; charset=utf-8').send(toCsv(flat));
  });
}
