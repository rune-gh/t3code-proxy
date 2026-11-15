/**
 * Pool chart: recorded (solid + gradient area) and projected (dashed) pooled
 * quota over the span, with reset-jump annotations, a Now rule, an "Empty"
 * marker, optional per-account lines, and a hover crosshair.
 *
 * Plain SVG in pixel space (width measured with ResizeObserver) so text and
 * strokes never distort.
 */

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { dayStarts, type PoolView, type SeriesPoint } from '../poolModel';
import {
  formatBurnRate,
  formatDayTick,
  formatPoolPercent,
  formatSignedPercent,
  formatWeekdayTime,
  niceCeil,
} from '../poolFormat';
import styles from './PoolChart.module.scss';

export type PoolChartMode = 'remaining' | 'drain';

export interface PoolChartProps {
  view: PoolView;
  mode: PoolChartMode;
  showAccounts: boolean;
  spanStart: number;
  spanEnd: number;
  now: number;
  locale: string;
}

const HEIGHT = 350;
const MARGIN = { top: 34, right: 16, bottom: 30, left: 56 };
const DEFAULT_WIDTH = 960;
const LABEL_MIN_GAP_X = 40;

const linePath = (
  points: readonly SeriesPoint[],
  x: (t: number) => number,
  y: (v: number) => number
) =>
  points.length === 0
    ? ''
    : points
        .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t).toFixed(1)} ${y(p.value).toFixed(1)}`)
        .join('');

const areaPath = (
  points: readonly SeriesPoint[],
  x: (t: number) => number,
  y: (v: number) => number,
  baseline: number
) => {
  if (points.length < 2) return '';
  const first = x(points[0].t).toFixed(1);
  const last = x(points[points.length - 1].t).toFixed(1);
  return `${linePath(points, x, y)}L${last} ${baseline}L${first} ${baseline}Z`;
};

/** Value at `t`: last point at or before (recorded) or linear interpolation (projected). */
function valueAt(points: readonly SeriesPoint[], t: number, interpolate: boolean): number | null {
  if (points.length === 0 || t < points[0].t || t > points[points.length - 1].t) return null;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = points[lo];
  const b = points[lo + 1];
  if (!interpolate || !b || b.t === a.t) return a.value;
  return a.value + ((b.value - a.value) * (t - a.t)) / (b.t - a.t);
}

export function PoolChart({
  view,
  mode,
  showAccounts,
  spanStart,
  spanEnd,
  now,
  locale,
}: PoolChartProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const gradientId = useId().replace(/:/g, '');
  const clipId = `${gradientId}-clip`;

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(320, Math.round(node.clientWidth)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const drain = mode === 'drain';
  const recordedSeries = drain ? view.recordedRate : view.recorded;
  const projectedSeries = drain ? view.projectedRate : view.projected;

  const plotLeft = MARGIN.left;
  const plotRight = width - MARGIN.right;
  const plotTop = MARGIN.top;
  const plotBottom = HEIGHT - MARGIN.bottom;
  const span = Math.max(1, spanEnd - spanStart);

  const yMax = useMemo(() => {
    if (!drain) return view.max > 0 ? view.max : 100;
    const peak = Math.max(
      0,
      ...recordedSeries.map((p) => p.value),
      ...projectedSeries.map((p) => p.value)
    );
    return niceCeil(Math.max(1, peak * 1.15));
  }, [drain, projectedSeries, recordedSeries, view.max]);

  const x = (time: number) => plotLeft + ((time - spanStart) / span) * (plotRight - plotLeft);
  const y = (value: number) =>
    plotBottom - (Math.min(Math.max(value, 0), yMax) / yMax) * (plotBottom - plotTop);

  const formatValue = (value: number) => (drain ? formatBurnRate(value) : formatPoolPercent(value));

  const days = useMemo(() => dayStarts(spanStart, spanEnd), [spanStart, spanEnd]);
  const dayLabels = useMemo(() => {
    const bounds = [spanStart, ...days.filter((d) => d > spanStart), spanEnd];
    const labels: { t: number; label: string }[] = [];
    for (let i = 0; i < bounds.length - 1; i += 1) {
      const from = bounds[i];
      const to = bounds[i + 1];
      // Only label (nearly) whole days so partial edges don't crowd the axis.
      if (to - from < 0.6 * 86_400_000) continue;
      const mid = from + (to - from) / 2;
      labels.push({ t: mid, label: formatDayTick(mid, locale) });
    }
    return labels;
  }, [days, locale, spanEnd, spanStart]);

  // Jump annotations, greedily thinned so labels never overlap.
  const jumpLabels = useMemo(() => {
    if (drain) return [];
    const out: { x: number; y: number; label: string; projected: boolean }[] = [];
    [...view.jumps]
      .sort((a, b) => a.t - b.t)
      .forEach((jump) => {
        const jx = plotLeft + ((jump.t - spanStart) / span) * (plotRight - plotLeft);
        const jy =
          plotBottom - (Math.min(Math.max(jump.value, 0), yMax) / yMax) * (plotBottom - plotTop);
        const labelY = Math.max(plotTop - 6, jy - 9);
        const clash = out.some(
          (other) => Math.abs(other.x - jx) < LABEL_MIN_GAP_X && Math.abs(other.y - labelY) < 14
        );
        if (clash || jx < plotLeft || jx > plotRight) return;
        out.push({
          x: jx,
          y: labelY,
          label: formatSignedPercent(jump.amount),
          projected: jump.projected,
        });
      });
    return out;
  }, [drain, plotBottom, plotLeft, plotRight, plotTop, span, spanStart, view.jumps, yMax]);

  const nowVisible = now >= spanStart && now <= spanEnd;
  const nowX = x(now);
  const nowValue = drain
    ? (recordedSeries[recordedSeries.length - 1]?.value ?? view.burnRate)
    : view.current;
  const emptyAt = !drain ? view.poolEmptyAt : null;

  // Hover lookup.
  const hover = useMemo(() => {
    if (hoverX === null) return null;
    const time = spanStart + ((hoverX - plotLeft) / (plotRight - plotLeft)) * span;
    const projected = time > now;
    const value = projected
      ? valueAt(projectedSeries, time, true)
      : valueAt(recordedSeries, time, false);
    if (value === null) return { time, value: null, projected };
    return { time, value, projected };
  }, [hoverX, now, plotLeft, plotRight, projectedSeries, recordedSeries, span, spanStart]);

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left;
    setHoverX(px < plotLeft || px > plotRight ? null : px);
  };

  const yTicks = [0, yMax / 2, yMax];
  const recordedLine = linePath(recordedSeries, x, y);
  const projectedLine = linePath(projectedSeries, x, y);
  const recordedArea = areaPath(recordedSeries, x, y, plotBottom);
  const projectedArea = areaPath(projectedSeries, x, y, plotBottom);

  const summary = drain
    ? t('quota_pool.chart_summary_drain', {
        defaultValue: 'Drain rate over time; currently {{rate}}.',
        rate: formatBurnRate(view.burnRate),
      })
    : t('quota_pool.chart_summary', {
        defaultValue: 'Pooled quota over time: {{current}} of {{max}} left.',
        current: formatPoolPercent(view.current),
        max: formatPoolPercent(view.max),
      });

  const tooltipFlip = hoverX !== null && hoverX > width - 260;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <svg
        className={styles.svg}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={summary}
        onPointerMove={onPointerMove}
        onPointerLeave={() => setHoverX(null)}
      >
        <defs>
          <linearGradient
            id={`${gradientId}-rec`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            x2="0"
            y1={plotTop}
            y2={plotBottom}
          >
            <stop offset="0%" className={styles.stopTop} />
            <stop offset="100%" className={styles.stopBottom} />
          </linearGradient>
          <linearGradient
            id={`${gradientId}-proj`}
            gradientUnits="userSpaceOnUse"
            x1="0"
            x2="0"
            y1={plotTop}
            y2={plotBottom}
          >
            <stop offset="0%" className={styles.stopTopSoft} />
            <stop offset="100%" className={styles.stopBottom} />
          </linearGradient>
          <clipPath id={clipId}>
            <rect
              x={plotLeft}
              y={plotTop - 2}
              width={Math.max(0, plotRight - plotLeft)}
              height={plotBottom - plotTop + 4}
            />
          </clipPath>
        </defs>

        {/* Day columns */}
        {days.map((day) => (
          <line
            key={day}
            className={styles.dayRule}
            x1={x(day)}
            x2={x(day)}
            y1={plotTop}
            y2={plotBottom}
          />
        ))}

        {/* Horizontal gridlines + y labels */}
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              className={styles.gridRule}
              x1={plotLeft}
              x2={plotRight}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              className={styles.axisLabel}
              x={plotLeft - 12}
              y={y(tick)}
              textAnchor="end"
              dy="0.32em"
            >
              {formatValue(tick)}
            </text>
          </g>
        ))}

        {dayLabels.map((label) => (
          <text
            key={label.t}
            className={styles.axisLabel}
            x={x(label.t)}
            y={plotBottom + 20}
            textAnchor="middle"
          >
            {label.label}
          </text>
        ))}

        <g clipPath={`url(#${clipId})`}>
          {projectedArea && <path d={projectedArea} fill={`url(#${gradientId}-proj)`} />}
          {recordedArea && <path d={recordedArea} fill={`url(#${gradientId}-rec)`} />}

          {showAccounts &&
            view.accounts.map((account) => {
              const rec = drain ? account.recordedRate : account.recorded;
              const proj = drain ? account.projectedRate : account.projected;
              return (
                <g key={account.authIndex}>
                  <path className={styles.accountLine} d={linePath(rec, x, y)} />
                  <path
                    className={`${styles.accountLine} ${styles.dashed}`}
                    d={linePath(proj, x, y)}
                  />
                </g>
              );
            })}

          {projectedLine && (
            <path className={`${styles.line} ${styles.dashed}`} d={projectedLine} />
          )}
          {recordedLine && <path className={styles.line} d={recordedLine} />}
        </g>

        {jumpLabels.map((label) => (
          <text
            key={`${label.x}-${label.y}`}
            className={styles.jumpLabel}
            x={label.x}
            y={label.y}
            textAnchor="middle"
          >
            {label.label}
          </text>
        ))}

        {nowVisible && (
          <g>
            <line
              className={styles.nowRule}
              x1={nowX}
              x2={nowX}
              y1={plotTop - 6}
              y2={plotBottom + 30}
            />
            <text className={styles.nowLabel} x={nowX} y={plotTop - 14} textAnchor="middle">
              {t('quota_pool.now', { defaultValue: 'Now' })}
            </text>
            {recordedSeries.length > 0 && (
              <circle className={styles.nowDot} cx={nowX} cy={y(nowValue)} r={4} />
            )}
          </g>
        )}

        {emptyAt !== null && (
          <g>
            <text
              className={styles.emptyLabel}
              x={Math.min(Math.max(x(emptyAt), plotLeft + 70), plotRight - 70)}
              y={plotBottom - 14}
              textAnchor="middle"
            >
              {t('quota_pool.empty_at', {
                defaultValue: 'Empty {{time}}',
                time: formatWeekdayTime(emptyAt, locale),
              })}
            </text>
            <circle className={styles.emptyRing} cx={x(emptyAt)} cy={plotBottom} r={5.5} />
          </g>
        )}

        {hover && hoverX !== null && (
          <g pointerEvents="none">
            <line
              className={styles.hoverRule}
              x1={hoverX}
              x2={hoverX}
              y1={plotTop}
              y2={plotBottom}
            />
            {hover.value !== null && (
              <circle className={styles.hoverDot} cx={hoverX} cy={y(hover.value)} r={4} />
            )}
          </g>
        )}
      </svg>

      {hover && hoverX !== null && hover.value !== null && (
        <div
          className={styles.tooltip}
          style={
            tooltipFlip
              ? { right: width - hoverX + 12, top: plotTop - 30 }
              : { left: hoverX + 12, top: plotTop - 30 }
          }
          role="status"
        >
          {formatWeekdayTime(hover.time, locale)}
          {' · '}
          {drain
            ? formatBurnRate(hover.value)
            : t('quota_pool.tooltip_left', {
                defaultValue: '{{value}} left',
                value: formatPoolPercent(hover.value),
              })}
          {' · '}
          {hover.projected
            ? t('quota_pool.projected_lower', { defaultValue: 'projected' })
            : t('quota_pool.recorded_lower', { defaultValue: 'recorded' })}
        </div>
      )}
    </div>
  );
}
