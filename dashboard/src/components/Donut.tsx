// Reusable donut chart used by /today (per-session drill) and /summary
// (across-day aggregates). Extracted from features/today/DetailPane.tsx
// — same arc math, same legend layout, same active-key dimming semantics.
//
// Original lived inline in DetailPane because it had only one caller.
// /summary needs the same component, so the math + JSX moved here.
// DetailPane now imports from this module.
//
// API:
//   <Donut slices totalMs size [activeKey] [onSliceClick] />
//      Renders the SVG arcs + center total label.
//
//   <DonutPanel title slices totalMs size [activeKey] [onSliceClick]
//               [drillable] />
//      Donut + legend in a flex row. `drillable` toggles row hover/click.
//
// Slice colors are a caller responsibility — pass real hex; this module
// doesn't bake palettes.

import { cn } from '@/lib/cn';

export type Slice = {
  key: string;
  label: string;
  ms: number;
  color: string;
};

// "0m" / "47m" / "2h 15m" — matches the formatter used in DetailPane.
// Not exported as a duplicate of lib/format.ts:formatDurationMs because
// we want a slightly tighter format for legend rows ("<1m", "h" with no
// trailing "0m"). If those diverge, this is the canonical version for
// donut callers.
export function humanizeMs(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 1) return '<1m';
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ---------------------------------------------------------------------
// SVG arc helpers — individually-clickable slice paths.
// A previous stroke-dasharray approach rendered each slice as a full
// circle whose stroke was visible only in an arc range; the LAST drawn
// circle covered every other circle's hit area so clicks always routed
// to the smallest (last) slice. Real arc paths fix this.
// ---------------------------------------------------------------------

function polarToCart(
  cx: number,
  cy: number,
  r: number,
  angleDeg: number,
): [number, number] {
  // angleDeg: 0 = 12 o'clock, increasing clockwise.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function singleArcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const [x1o, y1o] = polarToCart(cx, cy, outerR, startAngleDeg);
  const [x2o, y2o] = polarToCart(cx, cy, outerR, endAngleDeg);
  const [x1i, y1i] = polarToCart(cx, cy, innerR, endAngleDeg);
  const [x2i, y2i] = polarToCart(cx, cy, innerR, startAngleDeg);
  const largeArc = endAngleDeg - startAngleDeg > 180 ? 1 : 0;
  return [
    `M ${x1o} ${y1o}`,
    `A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2o} ${y2o}`,
    `L ${x1i} ${y1i}`,
    `A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2i} ${y2i}`,
    'Z',
  ].join(' ');
}

// Public arc helper. Splits any sweep > 180° into two sub-arcs so SVG
// `A` never has near-coincident endpoints (which renders as a degener-
// ate sliver or invisible). Two M…Z subpaths concatenated share a
// single fill — visually one slice. Without this, a 99% slice (sweep
// ~357°) would either fail to render or render as a thin chord.
export function arcPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const sweep = endAngleDeg - startAngleDeg;
  if (sweep <= 180) {
    return singleArcPath(cx, cy, outerR, innerR, startAngleDeg, endAngleDeg);
  }
  const mid = startAngleDeg + sweep / 2;
  return [
    singleArcPath(cx, cy, outerR, innerR, startAngleDeg, mid),
    singleArcPath(cx, cy, outerR, innerR, mid, endAngleDeg),
  ].join(' ');
}

// ---------------------------------------------------------------------
// Donut — path-based arc slices, individually clickable.
// ---------------------------------------------------------------------

export function Donut({
  slices,
  totalMs,
  size,
  activeKey,
  onSliceClick,
  centerLabel,
}: {
  slices: Slice[];
  totalMs: number;
  size: number;
  activeKey?: string;
  onSliceClick?: (key: string) => void;
  // Override the center text. Defaults to humanizeMs(totalMs).
  centerLabel?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const padding = 4;
  const outerR = size / 2 - padding;
  // ~38% donut thickness. Visually chunky without crowding center text.
  const innerR = outerR * 0.62;

  // Reserve a small visual gap between adjacent slices. With a single
  // 100% slice we render a full ring instead — arc paths don't draw
  // at startAngle === endAngle.
  const minGapDeg = slices.length > 1 ? 1.5 : 0;
  const sweepBudget = 360 - minGapDeg * slices.length;
  let cur = 0;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="shrink-0"
    >
      {/* track */}
      <circle
        cx={cx}
        cy={cy}
        r={(outerR + innerR) / 2}
        fill="none"
        stroke="rgb(var(--c-line))"
        strokeWidth={outerR - innerR}
      />
      {slices.length === 1 ? (
        <circle
          cx={cx}
          cy={cy}
          r={(outerR + innerR) / 2}
          fill="none"
          stroke={slices[0].color}
          strokeWidth={outerR - innerR}
          onClick={
            onSliceClick ? () => onSliceClick(slices[0].key) : undefined
          }
          className={onSliceClick ? 'cursor-pointer' : undefined}
        >
          <title>{`${slices[0].label} · ${humanizeMs(slices[0].ms)}`}</title>
        </circle>
      ) : (
        slices.map((s) => {
          const sweep = (s.ms / totalMs) * sweepBudget;
          const startA = cur;
          const endA = cur + sweep;
          cur = endA + minGapDeg;
          const dimmed = activeKey && activeKey !== s.key;
          return (
            <path
              key={s.key}
              d={arcPath(cx, cy, outerR, innerR, startA, endA)}
              fill={s.color}
              fillOpacity={dimmed ? 0.35 : 1}
              onClick={
                onSliceClick ? () => onSliceClick(s.key) : undefined
              }
              className={cn(
                'transition-opacity',
                onSliceClick && 'cursor-pointer',
              )}
            >
              <title>{`${s.label} · ${humanizeMs(s.ms)}`}</title>
            </path>
          );
        })
      )}
      <text
        x={cx}
        y={cy - innerR * 0.05}
        textAnchor="middle"
        className="fill-ink"
        style={{ fontSize: innerR * 0.42, fontWeight: 600 }}
      >
        {centerLabel ?? humanizeMs(totalMs)}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------
// Legend — clickable rows when drillable
// ---------------------------------------------------------------------

export function DonutLegend({
  slices,
  totalMs,
  activeKey,
  drillable,
  onRowClick,
  maxRows = 8,
}: {
  slices: Slice[];
  totalMs: number;
  activeKey?: string;
  drillable: boolean;
  onRowClick?: (key: string) => void;
  maxRows?: number;
}) {
  const visible = slices.slice(0, maxRows);
  const hidden = slices.slice(maxRows);
  const hiddenMs = hidden.reduce((s, x) => s + x.ms, 0);

  return (
    <ul
      className="text-sm flex-1 min-w-0 max-h-[260px] overflow-y-auto overflow-x-hidden"
    >
      {visible.map((s) => {
        const pct = totalMs > 0 ? Math.round((s.ms / totalMs) * 100) : 0;
        const dimmed = activeKey && activeKey !== s.key;
        return (
          <li
            key={s.key}
            className={cn(
              'grid items-center gap-x-3 py-1 -mx-2 px-2 rounded transition-opacity',
              drillable && 'cursor-pointer hover:bg-paper-hover',
              dimmed && 'opacity-50',
            )}
            style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto auto' }}
            onClick={
              drillable && onRowClick ? () => onRowClick(s.key) : undefined
            }
          >
            <span
              className="inline-block w-3 h-3 rounded-sm"
              style={{ background: s.color }}
            />
            <span className="text-ink truncate">{s.label}</span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end">
              {humanizeMs(s.ms)}
            </span>
            <span className="text-ink-subtle tabular-nums text-xs justify-self-end w-9 text-right">
              {pct}%
            </span>
          </li>
        );
      })}
      {hidden.length > 0 && (
        <li
          className="grid items-center gap-x-3 py-1 -mx-2 px-2 text-ink-subtle italic"
          style={{ gridTemplateColumns: 'auto 1fr auto auto' }}
          title={`Misc bucket: ${hidden.length} small slices clumped`}
        >
          <span />
          <span className="truncate">+{hidden.length} more</span>
          <span className="tabular-nums text-xs justify-self-end">
            {humanizeMs(hiddenMs)}
          </span>
          <span className="tabular-nums text-xs justify-self-end w-9 text-right">
            {totalMs > 0 ? Math.round((hiddenMs / totalMs) * 100) : 0}%
          </span>
        </li>
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------
// DonutPanel — donut + legend in one cell
// ---------------------------------------------------------------------

export function DonutPanel({
  title,
  slices,
  totalMs,
  size,
  activeKey,
  onSliceClick,
  drillable = false,
  centerLabel,
}: {
  // Optional uppercase section label above the donut. Omit for the
  // drill panel where a breadcrumb already labels the section.
  title?: string;
  slices: Slice[];
  totalMs: number;
  size: number;
  activeKey?: string;
  onSliceClick?: (key: string) => void;
  drillable?: boolean;
  centerLabel?: string;
}) {
  return (
    <div className="min-w-0">
      {title && (
        <div className="text-xs text-ink-subtle uppercase tracking-wider font-semibold mb-2">
          {title}
        </div>
      )}
      <div className="flex items-center gap-5 flex-wrap">
        <Donut
          slices={slices}
          totalMs={totalMs}
          size={size}
          activeKey={activeKey}
          onSliceClick={onSliceClick}
          centerLabel={centerLabel}
        />
        <DonutLegend
          slices={slices}
          totalMs={totalMs}
          activeKey={activeKey}
          drillable={drillable && !!onSliceClick}
          onRowClick={onSliceClick}
        />
      </div>
    </div>
  );
}
