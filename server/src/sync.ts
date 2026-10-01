import type { FastifyBaseLogger } from 'fastify';
import { NotConnectedError } from './auth.js';
import { config } from './config.js';
import { DATA_TYPES, DATA_TYPES_BY_ID, extractTimes, pointKey, type DataTypeDef } from './dataTypes.js';
import { finishSyncRun, getSyncState, saveSyncState, startSyncRun, upsertDataPoints } from './db.js';
import { listDataPoints } from './healthClient.js';

/** Re-read this much before the cursor so late-arriving or updated points are picked up. Upserts dedupe. */
const OVERLAP_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TypeResult {
  dataType: string;
  status: 'pending' | 'running' | 'success' | 'failed';
  fetched: number;
  from?: string;
  error?: string;
}

export interface SyncProgress {
  runId: number;
  startedAt: string;
  results: TypeResult[];
}

let current: SyncProgress | null = null;

export const currentSync = () => current;

function startDate(def: DataTypeDef, explicitFrom?: Date): Date {
  if (explicitFrom) return explicitFrom;
  const cursor = getSyncState(def.id)?.cursor;
  if (cursor) return new Date(Date.parse(cursor) - OVERLAP_MS);
  return new Date(Date.now() - config.backfillDays * DAY_MS);
}

async function syncType(def: DataTypeDef, result: TypeResult, explicitFrom?: Date) {
  const from = startDate(def, explicitFrom);
  result.from = from.toISOString();
  result.status = 'running';

  const previous = getSyncState(def.id);
  let cursor = previous?.cursor ?? null;
  try {
    for await (const page of listDataPoints(def.id, { filter: def.filterFrom(from), pageSize: def.pageSize })) {
      const rows = page.map((point) => {
        const { start, end } = extractTimes(def, point);
        // Sleep is filtered by end time, so its cursor must track end time too.
        const mark = def.id === 'sleep' ? end : start;
        if (mark && (!cursor || mark > cursor)) cursor = mark;
        return {
          name: pointKey(def, point, start, end),
          data_type: def.id,
          start_time: start,
          end_time: end,
          raw_json: JSON.stringify(point),
        };
      });
      upsertDataPoints(rows);
      result.fetched += rows.length;
    }
    saveSyncState({ data_type: def.id, cursor, last_synced_at: new Date().toISOString(), last_error: null });
    result.status = 'success';
  } catch (err) {
    const message = (err as Error).message;
    saveSyncState({
      data_type: def.id,
      cursor,
      last_synced_at: previous?.last_synced_at ?? null,
      last_error: message,
    });
    result.status = 'failed';
    result.error = message;
    if (err instanceof NotConnectedError) throw err;
  }
}

/**
 * Starts a sync in the background. Types are synced one after another to stay
 * well within API quotas. Throws if a sync is already running.
 */
export function startSync(log: FastifyBaseLogger, opts: { types?: string[]; from?: string } = {}): SyncProgress {
  if (current) throw new Error('A sync is already running');

  const defs = opts.types?.length
    ? opts.types.map((id) => {
        const def = DATA_TYPES_BY_ID.get(id);
        if (!def) throw new Error(`Unknown data type: ${id}`);
        return def;
      })
    : DATA_TYPES;
  const explicitFrom = opts.from ? new Date(opts.from) : undefined;
  if (explicitFrom && Number.isNaN(explicitFrom.getTime())) throw new Error(`Invalid from date: ${opts.from}`);

  const progress: SyncProgress = {
    runId: startSyncRun(),
    startedAt: new Date().toISOString(),
    results: defs.map((d) => ({ dataType: d.id, status: 'pending', fetched: 0 })),
  };
  current = progress;

  void (async () => {
    try {
      for (const [i, def] of defs.entries()) {
        await syncType(def, progress.results[i], explicitFrom);
      }
    } catch (err) {
      log.warn({ err }, 'sync aborted');
    } finally {
      const failed = progress.results.filter((r) => r.status !== 'success').length;
      const status = failed === 0 ? 'success' : failed === progress.results.length ? 'failed' : 'partial';
      finishSyncRun(progress.runId, status, progress.results);
      log.info({ runId: progress.runId, status, results: progress.results }, 'sync finished');
      current = null;
    }
  })();

  return progress;
}
