import { DatePipe, DecimalPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MessageService } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageModule } from 'primeng/message';
import { TableModule } from 'primeng/table';
import { TagModule } from 'primeng/tag';
import { ApiService, Status, toIsoDate, TypeResult } from '../../core/api.service';

const POLL_MS = 1500;

type Severity = 'success' | 'info' | 'warn' | 'danger' | 'secondary';

@Component({
  selector: 'app-connect-sync',
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    DecimalPipe,
    ButtonModule,
    CardModule,
    DatePickerModule,
    MessageModule,
    TableModule,
    TagModule,
  ],
  templateUrl: './connect-sync.html',
  styleUrl: './connect-sync.scss',
})
export class ConnectSync implements OnInit {
  private readonly api = inject(ApiService);
  private readonly messages = inject(MessageService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly loginUrl = this.api.loginUrl;
  protected readonly status = signal<Status | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly backfillFrom = signal<Date | null>(null);
  protected readonly starting = signal(false);

  protected readonly connection = computed(() => this.status()?.connection);
  protected readonly running = computed(() => this.status()?.sync ?? null);
  protected readonly totalPoints = computed(() => this.status()?.types.reduce((n, t) => n + t.count, 0) ?? 0);
  protected readonly today = new Date();

  /** Live per-type progress while a sync runs, keyed by data type. */
  protected readonly progress = computed(() => {
    const map = new Map<string, TypeResult>();
    for (const r of this.running()?.results ?? []) map.set(r.dataType, r);
    return map;
  });

  private pollTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.pollTimer));
  }

  ngOnInit() {
    this.handleAuthRedirect();
    this.refresh();
  }

  protected refresh() {
    clearTimeout(this.pollTimer);
    this.api.status().subscribe({
      next: (s) => {
        const wasRunning = this.running();
        this.status.set(s);
        this.loadError.set(null);
        if (s.sync) {
          this.pollTimer = setTimeout(() => this.refresh(), POLL_MS);
        } else if (wasRunning) {
          this.notifyFinished(s);
        }
      },
      error: (err: HttpErrorResponse) =>
        this.loadError.set(`Could not reach the local server (${err.status || 'offline'}). Is "npm run dev" running?`),
    });
  }

  protected syncNow() {
    const from = this.backfillFrom();
    this.starting.set(true);
    this.api.sync(from ? { from: toIsoDate(from) } : {}).subscribe({
      next: () => {
        this.starting.set(false);
        this.messages.add({ severity: 'info', summary: 'Sync started', detail: 'Fetching data from Google Health…' });
        this.refresh();
      },
      error: (err: HttpErrorResponse) => {
        this.starting.set(false);
        this.messages.add({ severity: 'error', summary: 'Sync failed to start', detail: err.error?.error ?? err.message });
        this.refresh();
      },
    });
  }

  protected disconnect() {
    this.api.logout().subscribe(() => {
      this.messages.add({ severity: 'info', summary: 'Disconnected', detail: 'Stored Google tokens were revoked.' });
      this.refresh();
    });
  }

  protected typeSeverity(id: string, lastError: string | null, lastSyncedAt: string | null): Severity {
    const live = this.progress().get(id);
    if (live) {
      return { pending: 'secondary', running: 'info', success: 'success', failed: 'danger' }[live.status] as Severity;
    }
    if (lastError) return 'danger';
    return lastSyncedAt ? 'success' : 'secondary';
  }

  protected typeLabel(id: string, lastError: string | null, lastSyncedAt: string | null): string {
    const live = this.progress().get(id);
    if (live) return live.status === 'running' ? `syncing (${live.fetched})` : live.status;
    if (lastError) return 'error';
    return lastSyncedAt ? 'synced' : 'never synced';
  }

  private notifyFinished(s: Status) {
    const results = s.lastRun?.details ?? [];
    const fetched = results.reduce((n, r) => n + r.fetched, 0);
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
      this.messages.add({
        severity: 'warn',
        summary: 'Sync finished with errors',
        detail: `${failed.map((r) => r.dataType).join(', ')} failed. ${fetched} points fetched.`,
        life: 8000,
      });
    } else {
      this.messages.add({ severity: 'success', summary: 'Sync complete', detail: `${fetched} data points fetched.` });
    }
  }

  private handleAuthRedirect() {
    const params = this.route.snapshot.queryParamMap;
    const auth = params.get('auth');
    if (!auth) return;
    if (auth === 'success') {
      this.messages.add({ severity: 'success', summary: 'Connected', detail: 'Google Health account connected.' });
    } else {
      this.messages.add({
        severity: 'error',
        summary: 'Connection failed',
        detail: params.get('message') ?? 'Unknown error',
        life: 10000,
      });
    }
    void this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }
}
