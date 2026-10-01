import { DatePipe, DecimalPipe, JsonPipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { CardModule } from 'primeng/card';
import { DatePickerModule } from 'primeng/datepicker';
import { MessageModule } from 'primeng/message';
import { SelectModule } from 'primeng/select';
import { TableLazyLoadEvent, TableModule } from 'primeng/table';
import { ApiService, DataPoint, Range, toIsoDate, TypeStatus } from '../../core/api.service';

const TIME_FIELDS = new Set(['interval', 'sampleTime', 'date', 'metadata']);

const payloadKey = (id: string) => id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** One-line summary of the scalar values of a data point payload, e.g. `count: 40`. */
function summarize(type: string, point: DataPoint): string {
  const payload = point.data[payloadKey(type)];
  if (!payload || typeof payload !== 'object') return '';
  return Object.entries(payload as Record<string, unknown>)
    .filter(([k]) => !TIME_FIELDS.has(k))
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.length}]`;
      if (v !== null && typeof v === 'object') return `${k}: {…}`;
      return `${k}: ${v}`;
    })
    .join(' · ');
}

function source(point: DataPoint): string {
  const src = point.data['dataSource'] as Record<string, any> | undefined;
  return src?.['device']?.['displayName'] || src?.['platform'] || '';
}

@Component({
  selector: 'app-data-browser',
  imports: [
    FormsModule,
    DatePipe,
    DecimalPipe,
    JsonPipe,
    ButtonModule,
    CardModule,
    DatePickerModule,
    MessageModule,
    SelectModule,
    TableModule,
  ],
  templateUrl: './data-browser.html',
  styleUrl: './data-browser.scss',
})
export class DataBrowser {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  /** Bound from the `?type=` query parameter. */
  readonly type = input<string>();

  protected readonly types = signal<TypeStatus[]>([]);
  protected readonly selectedType = computed(() => this.type() ?? this.types()[0]?.id ?? null);
  protected readonly selectedDef = computed(() => this.types().find((t) => t.id === this.selectedType()));
  protected readonly dateRange = signal<Date[] | null>(null);

  protected readonly rows = signal<DataPoint[]>([]);
  protected readonly total = signal(0);
  protected readonly first = signal(0);
  protected readonly pageSize = signal(50);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly expanded = signal<Record<string, boolean>>({});

  protected readonly range = computed<Range>(() => {
    const [start, end] = this.dateRange() ?? [];
    if (!start) return {};
    const to = new Date(end ?? start);
    to.setDate(to.getDate() + 1);
    return { from: toIsoDate(start), to: toIsoDate(to) };
  });

  protected readonly exportJson = computed(() => this.exportUrl('json'));
  protected readonly exportCsv = computed(() => this.exportUrl('csv'));

  protected readonly summarize = summarize;
  protected readonly source = source;

  constructor() {
    this.api.status().subscribe({
      next: (s) => this.types.set(s.types),
      error: (err: HttpErrorResponse) => this.error.set(`Could not load data types (${err.status || 'offline'}).`),
    });

    effect(() => {
      const type = this.selectedType();
      this.range();
      if (!type) return;
      this.first.set(0);
      this.expanded.set({});
      this.fetch(type, 0, this.pageSize());
    });
  }

  protected toggleRow(name: string) {
    this.expanded.update(({ [name]: open, ...rest }) => (open ? rest : { ...rest, [name]: true }));
  }

  protected selectType(id: string) {
    void this.router.navigate([], { queryParams: { type: id }, replaceUrl: true });
  }

  protected onRangeChange(value: Date[] | null) {
    // Range pickers emit [start, null] while the second date is still being picked.
    if (value && value.length === 2 && !value[1]) return;
    this.dateRange.set(value);
  }

  protected onLazyLoad(event: TableLazyLoadEvent) {
    const type = this.selectedType();
    const first = event.first ?? 0;
    const rows = event.rows ?? this.pageSize();
    if (!type || (first === this.first() && rows === this.pageSize() && this.rows().length)) return;
    this.first.set(first);
    this.pageSize.set(rows);
    this.fetch(type, first, rows);
  }

  private fetch(type: string, offset: number, limit: number) {
    this.loading.set(true);
    this.api.data(type, this.range(), limit, offset).subscribe({
      next: (page) => {
        this.rows.set(page.items);
        this.total.set(page.total);
        this.loading.set(false);
        this.error.set(null);
      },
      error: (err: HttpErrorResponse) => {
        this.loading.set(false);
        this.error.set(err.error?.error ?? err.message);
      },
    });
  }

  private exportUrl(format: 'json' | 'csv') {
    const type = this.selectedType();
    return type ? this.api.exportUrl(type, format, this.range()) : null;
  }
}
