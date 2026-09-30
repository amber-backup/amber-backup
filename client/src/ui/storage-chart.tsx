import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { RepositoryStatsHistory } from '../core/api';
import { fmtBytes, fmtDateTime } from '../core/format';
import { appTimezone } from '../core/timezone';
import { intlLocale, useT } from '../i18n';

/** One point of the total-storage series. */
export interface StoragePoint {
  t: number;
  bytes: number;
}

/**
 * Folds per-repository readings into one "total storage" series: at any time
 * the total is the sum of each repository's latest reading. Readings before the
 * window start only seed the baseline (collapsed into a single point at
 * `since`); the last value is carried forward to `now` so the line reaches the
 * right edge.
 */
export function totalStorageSeries(history: RepositoryStatsHistory, now: number): StoragePoint[] {
  const since = +new Date(history.since);
  const latest = new Map<string, number>();
  const sum = () => [...latest.values()].reduce((a, b) => a + b, 0);
  const out: StoragePoint[] = [];
  const sorted = [...history.points].sort((a, b) => +new Date(a.measured_at) - +new Date(b.measured_at));
  let seeded = false;
  for (const p of sorted) {
    const t = +new Date(p.measured_at);
    if (t < since) {
      latest.set(p.repository_id, p.size_bytes);
      seeded = true;
      continue;
    }
    if (seeded) {
      out.push({ t: since, bytes: sum() });
      seeded = false;
    }
    latest.set(p.repository_id, p.size_bytes);
    out.push({ t, bytes: sum() });
  }
  if (seeded) out.push({ t: since, bytes: sum() });
  if (out.length) out.push({ t: now, bytes: out[out.length - 1].bytes });
  return out;
}

/** A "nice" byte step: 1, 2, 2.5 or 5 × a power of ten, in the largest fitting 1024-based unit. */
function niceByteStep(raw: number): number {
  const r = Math.max(raw, 1);
  const unit = Math.pow(1024, Math.floor(Math.log(r) / Math.log(1024)));
  const frac = r / unit;
  const mag = Math.pow(10, Math.floor(Math.log10(frac)));
  const f = frac / mag;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * mag * unit;
}

/**
 * Value range of the y-axis and its tick values. Starts at zero unless the
 * readings move in a band that sits far above it (e.g. 830 → 890 GB); then the
 * axis zooms into that band so the growth is visible instead of a flat line.
 */
function byteAxis(vMin: number, vMax: number, count: number): { lo: number; hi: number; ticks: number[] } {
  const span = vMax - vMin;
  let lo = 0;
  // Headroom above the highest reading so the line never touches the top.
  let hi = Math.max(vMax * 1.15, 1);
  if (vMin > span) {
    // Pad the band on both sides; a flat series still gets some room around it.
    const pad = Math.max(span * 0.15, vMax * 0.02);
    lo = vMin - pad;
    hi = vMax + pad;
  }
  const step = niceByteStep((hi - lo) / count);
  const ticks: number[] = [];
  for (let i = Math.ceil(lo / step); i * step <= hi + step * 0.001; i++) ticks.push(i * step);
  return { lo, hi, ticks };
}

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString(intlLocale(), {
    month: 'short',
    day: 'numeric',
    timeZone: appTimezone(),
  });
}

function fmtMonth(t: number): string {
  return new Date(t).toLocaleDateString(intlLocale(), { month: 'short', timeZone: appTimezone() });
}

const DAY_MS = 86_400_000;
/** Approximate advance of one character of `.chart-label` (10.5px monospace). */
const LABEL_CHAR_W = 6.4;

/** Wall-clock time of `t` in the zone of `fmt`, encoded as if it were UTC. */
function wallClock(fmt: Intl.DateTimeFormat, t: number): number {
  const p = Object.fromEntries(fmt.formatToParts(t).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
}

/** Instant at which the wall-clock time `wall` (UTC-encoded) occurs in the zone of `fmt`. */
function zonedInstant(fmt: Intl.DateTimeFormat, wall: number): number {
  let t = wall;
  // Two passes settle the zone offset, DST changes included.
  for (let i = 0; i < 2; i++) t = wall - (wallClock(fmt, t) - t);
  return t;
}

/**
 * X-axis labels at midnight in the app timezone, one per day. When days get
 * too narrow for their labels, every 2nd/7th/14th day is labelled instead, and
 * beyond that the first of every 1st/2nd/3rd/6th/12th month.
 */
function dayLabels(tMin: number, tMax: number, pxPerMs: number): { t: number; label: string }[] {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: appTimezone(),
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const start = new Date(wallClock(fmt, tMin));
  const [y, m, d] = [start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()];
  // Widest day label (two-digit day) plus a gap between neighbours.
  const minGap = fmtDay(Date.UTC(2000, 8, 30, 12)).length * LABEL_CHAR_W + 16;
  const out: { t: number; label: string }[] = [];

  const dayStride = [1, 2, 7, 14].find((n) => n * DAY_MS * pxPerMs >= minGap);
  if (dayStride) {
    // Aligned to the calendar so labels stay put as the window moves: weekly
    // strides land on Mondays (day 4 counted from the Thursday 1970-01-01).
    const align = dayStride >= 7 ? 4 : 0;
    let first = Date.UTC(y, m, d) / DAY_MS;
    while ((first - align) % dayStride !== 0) first++;
    for (let wall = first * DAY_MS; ; wall += dayStride * DAY_MS) {
      const t = zonedInstant(fmt, wall);
      if (t > tMax) break;
      if (t >= tMin) out.push({ t, label: fmtDay(t) });
    }
    return out;
  }

  const monthStride = [1, 2, 3, 6, 12].find((n) => n * 30.4 * DAY_MS * pxPerMs >= minGap) ?? 12;
  // Aligned to the calendar (e.g. quarters start in Jan/Apr/Jul/Oct).
  for (let month = Math.ceil(m / monthStride) * monthStride; ; month += monthStride) {
    const t = zonedInstant(fmt, Date.UTC(y, month, 1));
    if (t > tMax) break;
    if (t >= tMin) out.push({ t, label: fmtMonth(t) });
  }
  return out;
}

const PAD = { top: 14, right: 16, bottom: 24, left: 8 };
const Y_LABEL_W = 60;

/**
 * Step-area chart of total repository storage over time. Single series, so no
 * legend; the panel title names it. A crosshair with a tooltip reads the value
 * at the pointer.
 */
export function StorageChart({ history }: { history: RepositoryStatsHistory }) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const now = useMemo(() => Date.now(), [history]);
  const series = useMemo(() => totalStorageSeries(history, now), [history, now]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize({ w: Math.floor(width), h: Math.floor(height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (series.length === 0) {
    return (
      <div className="storage-chart" ref={hostRef}>
        <div className="empty">{t.storageChart.empty}</div>
      </div>
    );
  }

  const { w, h } = size;
  const x0 = PAD.left + Y_LABEL_W;
  const x1 = w - PAD.right;
  const y0 = PAD.top;
  const y1 = h - PAD.bottom;
  const tMin = +new Date(history.since);
  const tMax = now;
  const values = series.map((p) => p.bytes);
  const { lo, hi, ticks } = byteAxis(Math.min(...values), Math.max(...values), 5);

  const sx = (t: number) => x0 + ((t - tMin) / Math.max(1, tMax - tMin)) * (x1 - x0);
  const sy = (v: number) => y1 - ((v - lo) / (hi - lo)) * (y1 - y0);

  // Step-after: a reading holds until the next one.
  let line = `M${sx(series[0].t).toFixed(1)},${sy(series[0].bytes).toFixed(1)}`;
  for (let i = 1; i < series.length; i++) {
    line += ` H${sx(series[i].t).toFixed(1)} V${sy(series[i].bytes).toFixed(1)}`;
  }
  const area = `${line} V${y1.toFixed(1)} H${sx(series[0].t).toFixed(1)} Z`;

  // Drop labels that would stick out of the chart at either edge.
  const xLabels = dayLabels(tMin, tMax, (x1 - x0) / Math.max(1, tMax - tMin)).filter(({ t, label }) => {
    const half = (label.length * LABEL_CHAR_W) / 2;
    return sx(t) - half >= 0 && sx(t) + half <= w;
  });

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (x < x0 || x > x1) return setHover(null);
    setHover(tMin + ((x - x0) / (x1 - x0)) * (tMax - tMin));
  };

  // Value at the hovered time = the latest reading at or before it.
  let hovered: StoragePoint | null = null;
  if (hover != null) {
    hovered = series[0];
    for (const p of series) if (p.t <= hover) hovered = p;
    hovered = { t: hover, bytes: hovered.bytes };
  }

  return (
    <div className="storage-chart" ref={hostRef}>
      {w > 0 && h > 0 && (
        <svg
          width={w}
          height={h}
          role="img"
          aria-label={t.storageChart.ariaLabel(fmtBytes(series[series.length - 1].bytes))}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={x0} x2={x1} y1={sy(v)} y2={sy(v)} />
              <text className="chart-label" x={x0 - 8} y={sy(v)} textAnchor="end" dominantBaseline="middle">
                {fmtBytes(v)}
              </text>
            </g>
          ))}
          {xLabels.map(({ t: tx, label }) => (
            <text key={tx} className="chart-label" x={sx(tx)} y={h - 6} textAnchor="middle">
              {label}
            </text>
          ))}
          <path className="chart-area" d={area} />
          <path className="chart-line" d={line} />
          {hovered && (
            <g>
              <line className="chart-crosshair" x1={sx(hovered.t)} x2={sx(hovered.t)} y1={y0} y2={y1} />
              <circle className="chart-marker" cx={sx(hovered.t)} cy={sy(hovered.bytes)} r={4} />
            </g>
          )}
        </svg>
      )}
      {hovered && w > 0 && (
        <div
          className="chart-tooltip"
          style={{
            left: Math.min(Math.max(sx(hovered.t), x0 + 70), x1 - 70),
            top: sy(hovered.bytes),
          }}
        >
          <strong>{fmtBytes(hovered.bytes)}</strong>
          <span>{fmtDateTime(new Date(hovered.t).toISOString())}</span>
        </div>
      )}
    </div>
  );
}

/** Byte delta with an explicit sign, e.g. "+1.2 GB". */
function fmtDelta(bytes: number): string {
  return `${bytes >= 0 ? '+' : '\u2212'}${fmtBytes(Math.round(Math.abs(bytes)))}`;
}

/** Below this much measured history an average per-day rate is too noisy to show. */
const MIN_RATE_DAYS = 1;

/**
 * Headline for the chart's panel: current total, the change over the window and
 * the average growth per day.
 */
export function StorageSummary({ history }: { history: RepositoryStatsHistory }) {
  const t = useT();
  const series = totalStorageSeries(history, Date.now());
  if (series.length === 0) return null;
  const first = series[0];
  const last = series[series.length - 1];
  const delta = last.bytes - first.bytes;
  // Averaged over the span that actually has readings, not the requested
  // window: a few days of history inside a 90d window would dilute the rate.
  const days = (last.t - first.t) / 86_400_000;
  const perDay = days >= MIN_RATE_DAYS ? delta / days : null;
  return (
    <span className="chart-summary">
      <strong>{fmtBytes(last.bytes)}</strong>
      <span className="muted">{t.storageChart.inWindow(fmtDelta(delta))}</span>
      {perDay !== null && <span className="muted">{t.storageChart.perDayAvg(fmtDelta(perDay))}</span>}
    </span>
  );
}
