/**
 * Readable names for pool window choices and backend window keys. Claude and
 * Codex choices keep their existing labels; any other key is read by
 * `parseWindowKey`, so a key the panel has never seen still gets a sensible
 * name ("Gemini Pro 5-hour", "Monthly", "Opus weekly") instead of a raw id.
 */

import { parseWindowKey, type ParsedWindowKey } from './poolModel';

type Translate = (key: string, options?: Record<string, unknown>) => string;

const NAMED_CHOICES: Record<string, string> = {
  weekly: 'quota_pool.window_weekly',
  fable: 'quota_pool.window_fable',
  five_hour: 'quota_pool.window_five_hour',
  seven_day: 'quota_pool.window_weekly',
  seven_day_fable: 'quota_pool.window_fable',
};

const lowerFirst = (value: string) => value.charAt(0).toLowerCase() + value.slice(1);

/**
 * Label for a window choice or backend window key. `reported` holds the names
 * the provider itself gives its windows; they win over a name read from the key.
 */
export function windowLabel(t: Translate, key: string, reported?: Record<string, string>): string {
  const named = NAMED_CHOICES[key];
  if (named) return t(named);
  if (reported?.[key]) return reported[key];
  const { span, scope } = parseWindowKey(key);
  const period = span ? spanLabel(t, span) : '';
  if (period && scope) {
    return t('quota_pool.window_scoped', { scope, window: lowerFirst(period) });
  }
  return period || scope || t('quota_pool.window_unknown');
}

/** "5-hour", "Weekly", "Monthly", "2-week". */
function spanLabel(t: Translate, span: NonNullable<ParsedWindowKey['span']>): string {
  if (span.count === 1 && span.unit === 'day') return t('quota_pool.window_daily');
  if (span.count === 1 && span.unit === 'week') return t('quota_pool.window_weekly');
  if (span.count === 1 && span.unit === 'month') return t('quota_pool.window_monthly');
  return t(`quota_pool.window_span_${span.unit}`, { count: span.count });
}

/** Resets filter label for a period class (`hour:5` → "5-hour", `week:1` → "Weekly"). */
export function periodClassLabel(t: Translate, value: string): string {
  const [unit, rawCount] = value.split(':');
  const count = Number(rawCount) || 1;
  if (unit === 'hour' && count === 5) return t('quota_pool.window_five_hour');
  if (unit !== 'hour' && unit !== 'day' && unit !== 'week' && unit !== 'month') {
    return t('quota_pool.window_unknown');
  }
  return spanLabel(t, { count, unit });
}

export interface GroupedWindowChoice {
  choice: string;
  /** What the window is scoped to ("Gemini Models"); null for the whole account. */
  group: string | null;
  /** Short period name for a tab ("5-hour", "Weekly"). */
  period: string;
}

export interface WindowChoiceGroups {
  /** Groups in first-seen order. */
  groups: string[];
  items: GroupedWindowChoice[];
}

/**
 * Split window choices into model groups and periods when that reads better
 * than one long list: Antigravity's "Gemini Models 5h", "Gemini Models weekly",
 * "Claude and GPT models 5h" and "Claude and GPT models weekly" become a group
 * picker and "5-hour | Weekly" tabs. Null when the choices do not split into
 * at least two groups with a group offering more than one period.
 */
export function groupWindowChoices(
  t: Translate,
  choices: readonly string[],
  reported?: Record<string, string>
): WindowChoiceGroups | null {
  const items: GroupedWindowChoice[] = [];
  for (const choice of choices) {
    if (NAMED_CHOICES[choice]) return null;
    const reportedName = reported?.[choice];
    if (!reportedName) {
      // A bare key (`seven_day_gemini_pro`): its parsed period and scope.
      const { span, scope } = parseWindowKey(choice);
      if (!span) return null;
      const group = scope?.replace(/^Group /, '') || null;
      items.push({ choice, group, period: spanLabel(t, span) });
      continue;
    }
    // A reported name: keep the provider's casing for the group ("Claude and GPT models").
    const words = reportedName.trim().split(/\s+/).filter(Boolean);
    const spanIndex = words.findIndex((word) => {
      const parsed = parseWindowKey(word);
      return parsed.span !== null && parsed.scope === null;
    });
    if (spanIndex < 0) return null;
    const rest = words.filter((_, index) => index !== spanIndex);
    items.push({
      choice,
      group: rest.length ? rest.join(' ') : null,
      period: spanLabel(t, parseWindowKey(words[spanIndex]).span!),
    });
  }
  const groups = [...new Set(items.map((item) => item.group ?? ''))];
  const multiPeriod = groups.some(
    (group) => items.filter((item) => (item.group ?? '') === group).length > 1
  );
  if (groups.length < 2 || !multiPeriod) return null;
  return { groups, items };
}

export interface WindowColumn {
  key: string;
  /** Full name ("Gemini Models weekly"), for the meter's accessible label. */
  label: string;
  /** Group heading when the windows split into groups ("Gemini Models"). */
  group?: string;
  /** Short period name shown under the group ("Weekly"). */
  period?: string;
}

/**
 * Table columns for a provider's windows (given longest first): shortest
 * first, and when the windows split into groups, group by group so each
 * group's 5-hour and weekly columns sit side by side.
 */
export function windowColumns(
  t: Translate,
  windows: readonly { key: string; periodHours?: number | null }[],
  reported?: Record<string, string>
): WindowColumn[] {
  // Shortest first; windows of the same length keep the order the provider reports them in.
  const shortestFirst = windows
    .map((window, index) => ({ window, index }))
    .sort(
      (a, b) =>
        (a.window.periodHours ?? Infinity) - (b.window.periodHours ?? Infinity) ||
        (a.window.periodHours == null ? b.index - a.index : a.index - b.index)
    )
    .map(({ window }) => window);
  const columns = shortestFirst.map((window) => ({
    key: window.key,
    label: windowLabel(t, window.key, reported),
  }));
  const grouped = groupWindowChoices(
    t,
    windows.map((window) => window.key),
    reported
  );
  if (!grouped) return columns;
  const itemOf = new Map(grouped.items.map((item) => [item.choice, item]));
  return grouped.groups.flatMap((group) =>
    columns
      .filter((column) => (itemOf.get(column.key)?.group ?? '') === group)
      .map((column) => ({
        ...column,
        group: group || t('quota_pool.window_group_account'),
        period: itemOf.get(column.key)?.period,
      }))
  );
}
