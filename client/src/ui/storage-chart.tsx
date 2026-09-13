import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { RepositoryStatsHistory } from '../core/api';
import { fmtBytes, fmtDateTime } from '../core/format';
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

/** "Nice" tick values for a byte axis from 0 to `max` (1024-based steps). */
function byteTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const unit = Math.pow(1024, Math.floor(Math.log(raw) / Math.log(1024)));
  const frac = raw / unit;
  const nice = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : frac <= 10 ? 10 : frac <= 20 ? 20 : frac <= 50 ? 50 : 100;
  const step = nice * unit;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

function fmtDay(t: number): string {
  return new Date(t).toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' });
}

const PAD = { top: 14, right: 16, bottom: 24, left: 8 };
const Y_LABEL_W = 52;

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
  const vMax = Math.max(...series.map((p) => p.bytes));
  // Headroom above the highest reading so the line never touches the top.
  const vTop = Math.max(vMax * 1.15, 1);
  const ticks = byteTicks(vTop, 3);

  const sx = (t: number) => x0 + ((t - tMin) / Math.max(1, tMax - tMin)) * (x1 - x0);
  const sy = (v: number) => y1 - (v / vTop) * (y1 - y0);

  // Step-after: a reading holds until the next one.
  let line = `M${sx(series[0].t).toFixed(1)},${sy(series[0].bytes).toFixed(1)}`;
  for (let i = 1; i < series.length; i++) {
    line += ` H${sx(series[i].t).toFixed(1)} V${sy(series[i].bytes).toFixed(1)}`;
  }
  const area = `${line} V${y1.toFixed(1)} H${sx(series[0].t).toFixed(1)} Z`;

  // Roughly one date label per 90px, from the window start.
  const nLabels = Math.max(2, Math.floor((x1 - x0) / 90));
  const xLabels = Array.from({ length: nLabels + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / nLabels);

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
          {xLabels.map((tx, i) => (
            <text
              key={tx}
              className="chart-label"
              x={sx(tx)}
              y={h - 6}
              textAnchor={i === 0 ? 'start' : i === nLabels ? 'end' : 'middle'}
            >
              {fmtDay(tx)}
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
