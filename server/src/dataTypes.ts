/**
 * Registry of the Google Health API data types this app syncs.
 *
 * The record kind decides how a type is filtered in `dataPoints.list` and
 * where its timestamps live in the payload. Filter syntax per kind:
 * https://developers.google.com/health/reference/rest/v4/users.dataTypes.dataPoints/list
 */

export type RecordKind = 'interval' | 'sample' | 'session' | 'daily';

export type ScopeKey = 'activity_and_fitness' | 'health_metrics_and_measurements' | 'sleep';

export interface DataTypeDef {
  /** Kebab-case id used in endpoint URLs, e.g. `heart-rate`. */
  id: string;
  label: string;
  group: 'Activity' | 'Heart' | 'Sleep' | 'Exercise' | 'Vitals';
  kind: RecordKind;
  scope: ScopeKey;
  /** Max page size the API accepts for this type. */
  pageSize: number;
  /** Builds the `filter` expression that selects everything at or after `from` (a UTC Date). */
  filterFrom: (from: Date) => string;
}

const snake = (id: string) => id.replaceAll('-', '_');

/** Key of the payload object in a DataPoint, e.g. `heart-rate` -> `heartRate`. */
export const payloadKey = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const civilDateTime = (d: Date) => d.toISOString().slice(0, 19);

const filters = {
  interval: (id: string) => (from: Date) => `${snake(id)}.interval.start_time >= "${rfc3339(from)}"`,
  sample: (id: string) => (from: Date) => `${snake(id)}.sample_time.physical_time >= "${rfc3339(from)}"`,
  daily: (id: string) => (from: Date) => `${snake(id)}.date >= "${isoDate(from)}"`,
};

const MAX_PAGE = 10_000;
const SESSION_PAGE = 25;

export const DATA_TYPES: DataTypeDef[] = [
  { id: 'steps', label: 'Steps', group: 'Activity', kind: 'interval', scope: 'activity_and_fitness', pageSize: MAX_PAGE, filterFrom: filters.interval('steps') },
  { id: 'distance', label: 'Distance', group: 'Activity', kind: 'interval', scope: 'activity_and_fitness', pageSize: MAX_PAGE, filterFrom: filters.interval('distance') },
  { id: 'total-calories', label: 'Total calories', group: 'Activity', kind: 'interval', scope: 'activity_and_fitness', pageSize: MAX_PAGE, filterFrom: filters.interval('total-calories') },

  { id: 'heart-rate', label: 'Heart rate', group: 'Heart', kind: 'sample', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.sample('heart-rate') },
  { id: 'daily-resting-heart-rate', label: 'Resting heart rate (daily)', group: 'Heart', kind: 'daily', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.daily('daily-resting-heart-rate') },

  {
    id: 'sleep', label: 'Sleep', group: 'Sleep', kind: 'session', scope: 'sleep', pageSize: SESSION_PAGE,
    // Sleep does not support civil_start_time; it is filtered by end time.
    filterFrom: (from) => `sleep.interval.end_time >= "${rfc3339(from)}"`,
  },

  {
    id: 'exercise', label: 'Exercise', group: 'Exercise', kind: 'session', scope: 'activity_and_fitness', pageSize: SESSION_PAGE,
    // Exercise sessions only support civil (local) start time filters.
    filterFrom: (from) => `exercise.interval.civil_start_time >= "${civilDateTime(from)}"`,
  },

  { id: 'heart-rate-variability', label: 'HRV', group: 'Vitals', kind: 'sample', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.sample('heart-rate-variability') },
  { id: 'daily-heart-rate-variability', label: 'HRV (daily)', group: 'Vitals', kind: 'daily', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.daily('daily-heart-rate-variability') },
  { id: 'daily-oxygen-saturation', label: 'SpO2 (daily)', group: 'Vitals', kind: 'daily', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.daily('daily-oxygen-saturation') },
  { id: 'daily-respiratory-rate', label: 'Respiratory rate (daily)', group: 'Vitals', kind: 'daily', scope: 'health_metrics_and_measurements', pageSize: MAX_PAGE, filterFrom: filters.daily('daily-respiratory-rate') },
];

export const DATA_TYPES_BY_ID = new Map(DATA_TYPES.map((t) => [t.id, t]));

export const SCOPES = [...new Set(DATA_TYPES.map((t) => t.scope))].map(
  (s) => `https://www.googleapis.com/auth/googlehealth.${s}.readonly`,
);

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const civilDateString = (d: CivilDate) => `${d.year}-${pad(d.month)}-${pad(d.day)}`;

/**
 * Extracts start/end timestamps from a DataPoint so rows can be indexed and
 * queried by time. Instants are ISO-8601 UTC; daily types use `YYYY-MM-DD`.
 */
export function extractTimes(def: DataTypeDef, point: Record<string, any>): { start: string | null; end: string | null } {
  const payload = point[payloadKey(def.id)] ?? {};
  switch (def.kind) {
    case 'interval':
    case 'session':
      return { start: payload.interval?.startTime ?? null, end: payload.interval?.endTime ?? null };
    case 'sample': {
      const t = payload.sampleTime?.physicalTime ?? null;
      return { start: t, end: t };
    }
    case 'daily': {
      const d = payload.date ? civilDateString(payload.date) : null;
      return { start: d, end: d };
    }
  }
}

/**
 * Interval points (e.g. steps) are not guaranteed to carry a `name`, so a
 * stable key is derived from type, time range and source.
 */
export function pointKey(def: DataTypeDef, point: Record<string, any>, start: string | null, end: string | null): string {
  if (typeof point.name === 'string' && point.name) return point.name;
  const src = point.dataSource ?? {};
  const source = src.device?.displayName ?? src.application?.packageName ?? src.platform ?? 'unknown';
  return `${def.id}/${start}/${end}/${source}`;
}
