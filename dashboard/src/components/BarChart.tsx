// Reusable bar chart used by /summary (sleep nights, top projects) and
// /trends (sleep trend, project ranking). Both orientations share one
// component so the visual idiom is consistent across pages — a project
// that's a horizontal bar on /summary looks the same on /trends.
//
// Why a shared component instead of inline divs:
//   - /summary previously rendered sleep nights as horizontal *cards*
//     (per-night stats). User feedback: "doesn't have to be a horizontal
//     row of cards" — a real chart is more legible.
//   - /summary's project bars and /trends's project ranking duplicated
//     the same horizontal-bar layout with subtly different proportions.
//   - /trends's sleep trend was already a vertical bar chart inline.
//
// API:
//   <BarChart items orientation [maxValue] [referenceValue] [height]
//             [valueFormat] [emptyLabel] [showValueLabels] />
//
// Slice colors are a caller responsibility — pass real hex per item, or
// rely on the neutral default. This module doesn't bake palettes.
//
// Tenet 1 (honest empty states): items with value === 0 render as a
// dimmed placeholder bar with the configured `emptyLabel` ("none" /
// "no data") rather than collapsing out of the chart. Days with a
// tracking gap should be visible as gaps.

import { cn } from '@/lib/cn';

export type BarItem = {
  // Stable identity (used as React key).
  key: string;
  // Primary label under (vertical) or before (horizontal) the bar.
  label: string;
  // Optional secondary label, smaller. e.g. date under day-name.
  sublabel?: string;
  // Numeric value the bar encodes. Same units across all items.
  // Items with value === 0 render as an empty placeholder (see above).
  value: number;
  // Per-bar fill color. Defaults to var(--c-accent) when omitted.
  color?: string;
  // Hover tooltip. Falls back to "label · formatted-value".
  tooltip?: string;
  // Optional small caption rendered with the value (e.g. "2 disruptions").
  // Only used in horizontal mode where there's room to the right.
  caption?: string;
};

export type BarChartProps = {
  items: BarItem[];
  // Bar direction.
  //   'vertical'   — bars rise from a baseline; one column per item.
  //                  Use for time series (date on X axis).
  //   'horizontal' — bars extend rightward; one row per item.
  //                  Use for ranked categorical data (top projects).
  orientation: 'horizontal' | 'vertical';
  // Bar fills are scaled to `maxValue`. Defaults to max of `items`.
  // Pass an explicit value to set a fixed reference (e.g. 8h sleep).
  maxValue?: number;
  // Optional reference line at this value (vertical mode only). Useful
  // for "8h sleep target" — renders as a dashed line across the chart.
  referenceValue?: number;
  // Height of the chart's bar area in pixels. For vertical: bar height.
  // For horizontal: total chart height is determined by row count, this
  // controls per-row bar height (default 12).
  height?: number;
  // Format the numeric value for the value label and default tooltip.
  // Receives raw `value` (the same units as `items[].value`).
  valueFormat?: (v: number) => string;
  // Caption rendered when an item's value is 0. Default "—".
  emptyLabel?: string;
  // Whether to render the formatted value next to / under each bar.
  showValueLabels?: boolean;
};

// Default formatter — pass-through to a plain number.
const defaultFormat = (v: number) => v.toFixed(0);

// ---------------------------------------------------------------------
// BarChart — orientation switch
// ---------------------------------------------------------------------

export function BarChart(props: BarChartProps) {
  return props.orientation === 'vertical' ? (
    <VerticalBars {...props} />
  ) : (
    <HorizontalBars {...props} />
  );
}

// ---------------------------------------------------------------------
// Vertical — for time series (sleep nights, daily duration)
//
// Layout: a CSS grid with one column per item. Each column has a
// fixed-height bar area, baseline at the bottom, then label / sublabel
// stacked underneath. Value label sits above the bar (or replaces it
// for empty days).
// ---------------------------------------------------------------------

function VerticalBars({
  items,
  maxValue,
  referenceValue,
  height = 80,
  valueFormat = defaultFormat,
  emptyLabel = '—',
  showValueLabels = true,
}: BarChartProps) {
  if (items.length === 0) return null;

  const dataMax = Math.max(0, ...items.map((i) => i.value));
  const scaleMax = Math.max(maxValue ?? dataMax, 1);

  const refPct =
    referenceValue !== undefined && referenceValue > 0 && referenceValue <= scaleMax
      ? (referenceValue / scaleMax) * 100
      : null;

  return (
    <div
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}
    >
      {items.map((item) => {
        const isEmpty = item.value <= 0;
        const fillPct = isEmpty ? 0 : Math.min(100, (item.value / scaleMax) * 100);
        const valueText = isEmpty ? emptyLabel : valueFormat(item.value);
        const tooltip = item.tooltip ?? `${item.label} · ${valueText}`;

        return (
          <div
            key={item.key}
            className="flex flex-col items-center gap-1.5 min-w-0"
          >
            {showValueLabels && (
              <div className="text-[10px] text-ink tabular-nums font-medium">
                {valueText}
              </div>
            )}
            <div
              className={cn(
                'w-full rounded-md overflow-hidden border flex flex-col-reverse relative',
                isEmpty
                  ? 'bg-paper-panel border-dashed border-line'
                  : 'bg-paper-panel border-line',
              )}
              style={{ height: `${height}px` }}
              title={tooltip}
            >
              {refPct !== null && (
                // Dashed reference line at `referenceValue`. Sits above
                // the bar fill so even an over-target bar shows where
                // the line would be. Pointer-events-none so the bar
                // tooltip still wins on hover.
                <div
                  className="absolute left-0 right-0 border-t border-dashed border-ink-subtle/40 pointer-events-none"
                  style={{ bottom: `${refPct}%` }}
                />
              )}
              {isEmpty ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] text-ink-subtle italic">
                    {emptyLabel}
                  </span>
                </div>
              ) : (
                <div
                  className="w-full"
                  style={{
                    height: `${fillPct}%`,
                    background: item.color ?? 'rgb(var(--c-accent))',
                  }}
                />
              )}
            </div>
            <div className="text-[11px] text-ink-subtle truncate w-full text-center">
              {item.label}
            </div>
            {item.sublabel && (
              <div className="text-[10px] text-ink-subtle truncate w-full text-center">
                {item.sublabel}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------
// Horizontal — for ranked categorical data (top projects, top apps)
//
// Layout: one grid row per item. Columns: label | bar track | value.
// Bar fills proportionally to scaleMax. Used at the top of /summary
// project list and inside the /today drill alongside the donut.
// ---------------------------------------------------------------------

function HorizontalBars({
  items,
  maxValue,
  height = 12,
  valueFormat = defaultFormat,
  emptyLabel = '—',
  showValueLabels = true,
}: BarChartProps) {
  if (items.length === 0) return null;

  const dataMax = Math.max(0, ...items.map((i) => i.value));
  const scaleMax = Math.max(maxValue ?? dataMax, 1);

  return (
    <ul className="space-y-2">
      {items.map((item) => {
        const isEmpty = item.value <= 0;
        const fillPct = isEmpty ? 0 : Math.min(100, (item.value / scaleMax) * 100);
        const valueText = isEmpty ? emptyLabel : valueFormat(item.value);
        const tooltip = item.tooltip ?? `${item.label} · ${valueText}`;

        return (
          <li
            key={item.key}
            className="grid items-center gap-x-3"
            style={{
              gridTemplateColumns: item.caption
                ? 'minmax(80px, 0.4fr) 1fr auto auto'
                : 'minmax(80px, 0.4fr) 1fr auto',
            }}
          >
            <span className="text-sm text-ink truncate" title={item.label}>
              {item.label}
            </span>
            <div
              className="rounded-full bg-paper-panel border border-line overflow-hidden"
              style={{ height: `${height}px` }}
              title={tooltip}
            >
              <div
                className="h-full rounded-full transition-[width]"
                style={{
                  width: `${fillPct}%`,
                  background: item.color ?? 'rgb(var(--c-accent))',
                }}
              />
            </div>
            {showValueLabels && (
              <span className="text-xs text-ink-subtle tabular-nums w-16 text-right">
                {valueText}
              </span>
            )}
            {item.caption && (
              <span className="text-xs text-ink-subtle tabular-nums w-16 text-right">
                {item.caption}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
