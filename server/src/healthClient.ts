import { getAccessToken } from './auth.js';

const BASE_URL = 'https://health.googleapis.com/v4';
const MAX_RETRIES = 5;

export class HealthApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Google Health API ${status}: ${body.slice(0, 500)}`);
    this.name = 'HealthApiError';
  }
}

export type DataPoint = Record<string, any>;

interface ListResponse {
  dataPoints?: DataPoint[];
  nextPageToken?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelay(res: Response, attempt: number): number {
  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  return Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 250;
}

async function get<T>(path: string, query: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE_URL}/${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${await getAccessToken()}`, Accept: 'application/json' },
    });
    if (res.ok) return (await res.json()) as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      throw new HealthApiError(res.status, await res.text());
    }
    await sleep(retryDelay(res, attempt));
  }
}

/** Yields pages of data points for `dataType`, following `nextPageToken` until exhausted. */
export async function* listDataPoints(
  dataType: string,
  opts: { filter?: string; pageSize?: number },
): AsyncGenerator<DataPoint[]> {
  let pageToken: string | undefined;
  do {
    const page = await get<ListResponse>(`users/me/dataTypes/${dataType}/dataPoints`, {
      filter: opts.filter,
      pageSize: opts.pageSize?.toString(),
      pageToken,
    });
    yield page.dataPoints ?? [];
    pageToken = page.nextPageToken || undefined;
  } while (pageToken);
}
