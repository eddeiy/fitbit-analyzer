import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type RecordKind = 'interval' | 'sample' | 'session' | 'daily';

export interface TypeStatus {
  id: string;
  label: string;
  group: string;
  kind: RecordKind;
  count: number;
  first: string | null;
  last: string | null;
  cursor: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
}

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

export interface Status {
  connection: {
    configured: boolean;
    connected: boolean;
    healthUserId: string | null;
    legacyUserId: string | null;
    scopes: string[];
    connectedAt: string | null;
  };
  backfillDays: number;
  sync: SyncProgress | null;
  lastRun: {
    id: number;
    started_at: string;
    finished_at: string | null;
    status: string;
    details: TypeResult[] | null;
  } | null;
  types: TypeStatus[];
}

export interface DataPoint {
  name: string;
  dataType: string;
  startTime: string | null;
  endTime: string | null;
  syncedAt: string;
  data: Record<string, unknown>;
}

export interface DataPage {
  total: number;
  limit: number;
  offset: number;
  items: DataPoint[];
}

export interface Range {
  /** Inclusive, `YYYY-MM-DD`. */
  from?: string;
  /** Exclusive, `YYYY-MM-DD`. */
  to?: string;
}

const rangeParams = (range: Range) => {
  let params = new HttpParams();
  if (range.from) params = params.set('from', range.from);
  if (range.to) params = params.set('to', range.to);
  return params;
};

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  readonly loginUrl = '/auth/login';

  status(): Observable<Status> {
    return this.http.get<Status>('/api/status');
  }

  sync(body: { types?: string[]; from?: string } = {}): Observable<SyncProgress> {
    return this.http.post<SyncProgress>('/api/sync', body);
  }

  logout(): Observable<{ ok: boolean }> {
    return this.http.post<{ ok: boolean }>('/auth/logout', {});
  }

  data(type: string, range: Range, limit: number, offset: number): Observable<DataPage> {
    const params = rangeParams(range).set('limit', limit).set('offset', offset);
    return this.http.get<DataPage>(`/api/data/${type}`, { params });
  }

  exportUrl(type: string, format: 'json' | 'csv', range: Range): string {
    const query = rangeParams(range).toString();
    return `/api/export/${type}.${format}${query ? `?${query}` : ''}`;
  }
}

/** Formats a Date as a local `YYYY-MM-DD` string. */
export function toIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
