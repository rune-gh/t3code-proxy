/**
 * Resets: when every account's quota comes back, for every provider at once.
 *
 * The pools answer "how much is left and when does it run out"; this answers
 * "when does it come back, and does it come back all at once". Four accounts
 * resetting on the same evening is a different position from four staggered
 * across a week, and the allowance an account still holds when its window
 * resets is lost, so the soonest resets and what is unspent on each lead.
 *
 * One lane per account window, grouped by provider under the same header as
 * the pool cards; accounts in routing order (soonest reset of their longest
 * window first). Bars run from when a window opened to when it resets: the
 * current one solid with its remaining share, upcoming ones dashed, elapsed
 * ones muted with what was left unspent when they reset. All maths lives in
 * resetCalendarModel.ts.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '@/components/ui/EmptyState';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { SegmentedControl } from '@/components/ui/Tabs';
import { Toolbar } from '@/components/ui/Toolbar';
import type { QuotaHistory } from '@/services/api';
import type { ResolvedTheme } from '@/types';
import { getAuthFileIcon, getTypeColor, getTypeLabel } from '@/features/authFiles/constants';
import type { CodexCreditsByAccount } from '../hooks/useCodexResetCredits';
import { creditExpiryMs } from '../providers/codex/resetCredits';
import { HOUR_MS } from '../quotaTimelineModel';
import {
  buildResetLanes,
  calendarDays,
  calendarSpan,
  groupLanesByAccount,
  NEXT_RESETS_LIMIT,
  periodClassHours,
  RESETS_FILTER_ALL,
  projectResetLane,
  upcomingResets,
  type CalendarBar,
  type LaneGroup,
  type ResetLane,
} from '../resetCalendarModel';
import {
  formatDuration,
  formatMoney,
  formatMonthDay,
  formatPoolPercent,
  formatWeekdayTime,
} from '../poolFormat';
import { formatPlanName } from '../poolPrefs';
import { periodClassLabel, windowLabel } from '../poolWindowLabels';
import type { PoolProvider } from '../poolModel';
import { SpanNav } from './SpanNav';
import styles from './ResetsView.module.scss';

/** A reset this close with this much left unspent is called out. */
const LOSS_WARNING_MS = 24 * HOUR_MS;
const LOSS_WARNING_PERCENT = 25;

const WEEKDAY_FORMAT: Intl.DateTimeFormatOptions = { weekday: 'short' };

export interface ResetsViewProps {
  /** Recorded history merged with live reads: the same data the pools read. */
  history: QuotaHistory;
  /** Providers shown, in page order (the provider tab already applied). */
  providers: readonly PoolProvider[];
  now: number;
  spanStart: number;
  spanEnd: number;
  isToday: boolean;
  onShift: (direction: -1 | 1) => void;
  onToday: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
  resolvedTheme: ResolvedTheme;
  locale: string;
  loading?: boolean;
  /** Banked Codex resets per auth index (markers and "Use reset"). */
  credits?: CodexCreditsByAccount;
  redeeming?: string | null;
  onUseReset?: (account: { authIndex: string; label: string; disabled: boolean }) => void;
}

export function ResetsView(props: ResetsViewProps) {
  const {
    history,
    providers,
    now,
    spanStart,
    spanEnd,
    isToday,
    onShift,
    onToday,
    filter,
    onFilterChange,
    resolvedTheme,
    locale,
    loading = false,
    credits,
    redeeming,
    onUseReset,
  } = props;
  const { t } = useTranslation();

  const allLanes = useMemo(
    () => buildResetLanes(history, { now, providers }),
    [history, now, providers]
  );
  const classes = useMemo(
    () =>
      [...new Set(allLanes.map((lane) => lane.periodClass))].sort(
        (a, b) => periodClassHours(a) - periodClassHours(b)
      ),
    [allLanes]
  );
  const activeFilter = filter !== RESETS_FILTER_ALL && classes.includes(filter) ? filter : 'all';
  const lanes = useMemo(
    () =>
      activeFilter === RESETS_FILTER_ALL
        ? allLanes
        : allLanes.filter((lane) => lane.periodClass === activeFilter),
    [activeFilter, allLanes]
  );
  const span = useMemo(
    () => calendarSpan({ start: spanStart, end: spanEnd }),
    [spanEnd, spanStart]
  );
  const days = useMemo(() => calendarDays(span), [span]);
  // Usage-triggered windows reset every few hours; they lead the list only when picked.
  const includeShort =
    activeFilter !== RESETS_FILTER_ALL && lanes.some((lane) => lane.usageTriggered);
  const upcoming = useMemo(
    () => upcomingResets(lanes, now, NEXT_RESETS_LIMIT, includeShort),
    [includeShort, lanes, now]
  );

  const laneName = (lane: ResetLane) =>
    windowLabel(
      t,
      lane.windowKey,
      lane.reportedLabel ? { [lane.windowKey]: lane.reportedLabel } : undefined
    );
  const providerIcon = (provider: string) => {
    const icon = getAuthFileIcon(provider, resolvedTheme);
    return icon ? <img src={icon} alt="" className={styles.icon} /> : null;
  };

  const toolbar = (
    <Toolbar
      ariaLabel={t('quota_resets.toolbar_label')}
      end={
        <SpanNav
          spanStart={spanStart}
          spanEnd={spanEnd}
          isToday={isToday}
          onShift={onShift}
          onToday={onToday}
          locale={locale}
        />
      }
    >
      {classes.length > 1 && (
        <SegmentedControl
          ariaLabel={t('quota_resets.filter_label')}
          size="sm"
          items={[
            { value: RESETS_FILTER_ALL, label: t('quota_resets.filter_all') },
            ...classes.map((value) => ({ value, label: periodClassLabel(t, value) })),
          ]}
          value={activeFilter}
          onChange={onFilterChange}
        />
      )}
    </Toolbar>
  );

  if (loading && allLanes.length === 0) {
    return (
      <div className={styles.view} aria-busy="true">
        {toolbar}
        <span className="sr-only">{t('quota_overview.loading')}</span>
        <Skeleton height={180} rounded={8} />
        <Skeleton height={260} rounded={8} />
      </div>
    );
  }

  if (allLanes.length === 0) {
    return (
      <div className={styles.view}>
        {toolbar}
        <EmptyState
          title={t('quota_resets.empty_title')}
          description={t('quota_resets.empty_desc')}
        />
      </div>
    );
  }

  const nowPercent =
    now >= span.startMs && now < span.endMs
      ? ((now - span.startMs) / (span.endMs - span.startMs)) * 100
      : null;
  const columns = days.map((day) => `minmax(0, ${day.durationMs / HOUR_MS}fr)`).join(' ');
  const todayStart = new Date(now).setHours(0, 0, 0, 0);
  const shownProviders = providers.filter((provider) =>
    lanes.some((lane) => lane.provider === provider)
  );
  const hasCredits = shownProviders.includes('codex') && Boolean(credits);

  return (
    <div className={styles.view}>
      {toolbar}

      <Section
        title={t('quota_resets.next_title')}
        description={t(includeShort ? 'quota_resets.next_desc_all' : 'quota_resets.next_desc_long')}
      >
        {upcoming.length === 0 ? (
          <p className={styles.quiet}>{t('quota_resets.next_none')}</p>
        ) : (
          <Table className={styles.nextTable} aria-label={t('quota_resets.next_title')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('quota_resets.col_resets')}</TableHead>
                <TableHead>{t('quota_resets.col_account')}</TableHead>
                <TableHead alignRight>{t('quota_resets.col_unspent')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {upcoming.map(({ lane, at, unspent, unspentMoney }) => {
                const atRisk =
                  unspent !== null &&
                  at - now <= LOSS_WARNING_MS &&
                  unspent >= LOSS_WARNING_PERCENT;
                return (
                  <TableRow key={lane.id}>
                    <TableCell className={styles.whenCell}>
                      <span className={styles.when}>
                        {t('quota_pool.in_duration', { duration: formatDuration(at - now) })}
                      </span>
                      <span className={styles.quiet}>{formatResetTime(lane, at, locale)}</span>
                    </TableCell>
                    <TableCell className={styles.whoCell}>
                      <span className={styles.who}>
                        {providerIcon(lane.provider)}
                        <span className={styles.ellipsis} data-sensitive title={lane.accountLabel}>
                          {lane.accountLabel}
                        </span>
                      </span>
                      <span className={`${styles.quiet} ${styles.ellipsis}`}>
                        {[
                          getTypeLabel(t, lane.provider),
                          lane.plan ? formatPlanName(lane.plan) : null,
                          laneName(lane),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </TableCell>
                    <TableCell alignRight className={styles.unspentCell}>
                      {unspent === null ? (
                        <span className={styles.quiet}>—</span>
                      ) : (
                        <span
                          className={styles.unspent}
                          data-risk={atRisk || undefined}
                          data-none={unspent < 0.5 || undefined}
                          title={atRisk ? t('quota_resets.loss_hint') : undefined}
                        >
                          <span className={styles.unspentValue}>{formatPoolPercent(unspent)}</span>
                          {unspentMoney !== null && lane.budget && (
                            <span className={styles.quiet}>
                              {t('quota_resets.money_of', {
                                amount: formatMoney(unspentMoney, lane.budget.currency, locale),
                                budget: formatMoney(
                                  lane.budget.amount,
                                  lane.budget.currency,
                                  locale
                                ),
                              })}
                            </span>
                          )}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Section>

      {shownProviders.length === 0 && (
        <p className={styles.quiet}>{t('quota_resets.filter_empty')}</p>
      )}

      {shownProviders.map((provider) => {
        const providerLanes = lanes.filter((lane) => lane.provider === provider);
        const groups = groupLanesByAccount(providerLanes);
        const color = getTypeColor(provider, resolvedTheme).text;
        return (
          <Section
            key={provider}
            title={
              <span className={styles.title}>
                {providerIcon(provider)}
                {getTypeLabel(t, provider)}
              </span>
            }
            description={t('quota_pool.accounts_count', { count: groups.length })}
          >
            <div
              className={styles.calendar}
              role="group"
              aria-label={t('quota_resets.calendar_label', {
                provider: getTypeLabel(t, provider),
              })}
              style={
                {
                  '--calendar-columns': columns,
                  '--lane-color': color,
                } as CSSProperties
              }
            >
              <div className={styles.axis} aria-hidden="true">
                <span className={styles.axisAccount}>{t('quota_resets.col_account')}</span>
                <span className={styles.axisWindow}>{t('quota_resets.col_window')}</span>
                <div className={styles.axisDays}>
                  {days.map((day) => {
                    const date = new Date(day.at);
                    return (
                      <span
                        key={day.at}
                        className={styles.axisDay}
                        data-today={day.at === todayStart || undefined}
                        data-weekend={date.getDay() === 0 || date.getDay() === 6 || undefined}
                        data-month-start={date.getDate() === 1 || undefined}
                      >
                        <span className={styles.weekday}>
                          {date.toLocaleDateString(locale, WEEKDAY_FORMAT)}
                        </span>
                        <span className={styles.date}>
                          {date.getDate() === 1 ? formatMonthDay(day.at, locale) : date.getDate()}
                        </span>
                      </span>
                    );
                  })}
                </div>
              </div>
              {groups.map((group) => (
                <AccountLanes
                  key={group.authIndex}
                  group={group}
                  days={days}
                  span={span}
                  now={now}
                  nowPercent={nowPercent}
                  todayStart={todayStart}
                  locale={locale}
                  laneName={laneName}
                  credits={provider === 'codex' ? credits : undefined}
                  redeeming={redeeming}
                  onUseReset={provider === 'codex' ? onUseReset : undefined}
                />
              ))}
            </div>
          </Section>
        );
      })}

      <ul className={styles.legend} aria-label={t('quota_resets.legend_label')}>
        <li className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchLive}`} aria-hidden="true" />
          {t('quota_resets.legend_current')}
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchNext}`} aria-hidden="true" />
          {t('quota_resets.legend_upcoming')}
        </li>
        <li className={styles.legendItem}>
          <span className={`${styles.swatch} ${styles.swatchPast}`} aria-hidden="true" />
          {t('quota_resets.legend_elapsed')}
        </li>
        {hasCredits && (
          <li className={styles.legendItem}>
            <span className={styles.swatchCredit} aria-hidden="true" />
            {t('quota_resets.legend_credit')}
          </li>
        )}
      </ul>
    </div>
  );
}

/** Weekly and shorter resets by weekday and time; monthly ones by date and time. */
function formatResetTime(lane: ResetLane, at: number, locale: string): string {
  return lane.monthly ? formatInstant(at, locale) : formatWeekdayTime(at, locale);
}

interface AccountLanesProps {
  group: LaneGroup;
  days: { at: number; durationMs: number }[];
  span: { startMs: number; endMs: number };
  now: number;
  nowPercent: number | null;
  todayStart: number;
  locale: string;
  laneName: (lane: ResetLane) => string;
  credits?: CodexCreditsByAccount;
  redeeming?: string | null;
  onUseReset?: ResetsViewProps['onUseReset'];
}

function AccountLanes(props: AccountLanesProps) {
  const {
    group,
    days,
    span,
    now,
    nowPercent,
    todayStart,
    locale,
    laneName,
    credits,
    redeeming,
    onUseReset,
  } = props;
  const { t } = useTranslation();
  const first = group.lanes[0];
  const entry = credits?.[group.authIndex];
  const banked = (entry?.credits ?? [])
    .map((credit) => ({ id: credit.id, expiresAt: creditExpiryMs(credit.expiresAt) }))
    .filter(
      (credit): credit is { id: string; expiresAt: number } =>
        credit.expiresAt !== null && credit.expiresAt > now
    );
  const width = span.endMs - span.startMs;
  const marks = banked.filter(
    (credit) => credit.expiresAt >= span.startMs && credit.expiresAt < span.endMs
  );

  return (
    <div
      className={styles.account}
      role="group"
      aria-label={first.accountLabel}
      data-disabled={first.disabled || undefined}
    >
      <div className={styles.accountLabel}>
        <span className={styles.accountName} data-sensitive title={first.accountLabel}>
          {first.accountLabel}
        </span>
        <span className={styles.accountMeta}>
          {first.plan && <span>{formatPlanName(first.plan)}</span>}
          {first.disabled && <span>{t('quota_accounts.badge_disabled')}</span>}
          {banked.length > 0 &&
            (onUseReset && !first.disabled ? (
              <button
                type="button"
                className={styles.useReset}
                disabled={redeeming !== null && redeeming !== undefined}
                aria-busy={redeeming === group.authIndex || undefined}
                onClick={() =>
                  onUseReset({
                    authIndex: group.authIndex,
                    label: first.accountLabel,
                    disabled: first.disabled,
                  })
                }
              >
                {t('quota_resets.use_reset', { count: banked.length })}
              </button>
            ) : (
              <span>{t('quota_resets.banked', { count: banked.length })}</span>
            ))}
        </span>
      </div>
      <div className={styles.lanes}>
        {group.lanes.map((lane, index) => (
          <Lane
            key={lane.id}
            lane={lane}
            name={laneName(lane)}
            days={days}
            span={span}
            now={now}
            nowPercent={nowPercent}
            todayStart={todayStart}
            locale={locale}
            marks={
              index === 0
                ? marks.map((mark) => ({
                    ...mark,
                    left: ((mark.expiresAt - span.startMs) / width) * 100,
                  }))
                : []
            }
          />
        ))}
      </div>
    </div>
  );
}

interface LaneProps {
  lane: ResetLane;
  name: string;
  days: { at: number; durationMs: number }[];
  span: { startMs: number; endMs: number };
  now: number;
  nowPercent: number | null;
  todayStart: number;
  locale: string;
  marks: { id: string; expiresAt: number; left: number }[];
}

function Lane({ lane, name, days, span, now, nowPercent, todayStart, locale, marks }: LaneProps) {
  const { t } = useTranslation();
  const bars = useMemo(
    () => projectResetLane(lane, span.startMs, span.endMs, now),
    [lane, now, span.endMs, span.startMs]
  );
  const describe = (bar: CalendarBar): string => {
    const range = `${formatInstant(bar.startMs, locale)} – ${formatInstant(bar.endMs, locale)}`;
    const state =
      bar.state === 'live'
        ? bar.remaining !== null
          ? t('quota_resets.bar_live', { value: formatPoolPercent(bar.remaining) })
          : t('quota_resets.legend_current')
        : bar.state === 'next'
          ? t('quota_resets.legend_upcoming')
          : bar.remaining !== null
            ? t('quota_resets.bar_past', { value: formatPoolPercent(bar.remaining) })
            : t('quota_resets.legend_elapsed');
    return `${name}: ${range}, ${state}`;
  };
  const barLabel = (bar: CalendarBar): ReactNode => {
    if (bar.state === 'live') {
      const value = bar.remaining !== null ? `${formatPoolPercent(bar.remaining)} · ` : '';
      return `${value}${formatResetTime(lane, bar.endMs, locale)}`;
    }
    if (bar.state === 'next') return formatResetTime(lane, bar.endMs, locale);
    return bar.remaining !== null && bar.remaining >= 0.5
      ? t('quota_resets.bar_past_short', { value: formatPoolPercent(bar.remaining) })
      : null;
  };

  return (
    <div className={styles.lane}>
      <span className={styles.laneName} title={name}>
        {name}
      </span>
      <div className={styles.track}>
        <div className={styles.grid} aria-hidden="true">
          {days.map((day) => {
            const weekday = new Date(day.at).getDay();
            return (
              <span
                key={day.at}
                data-today={day.at === todayStart || undefined}
                data-weekend={weekday === 0 || weekday === 6 || undefined}
              />
            );
          })}
        </div>
        {nowPercent !== null && (
          <span
            className={styles.nowLine}
            data-now=""
            style={{ left: `${nowPercent}%` }}
            aria-hidden="true"
          />
        )}
        {bars.length === 0 && (
          <span className={styles.idle}>
            {lane.resetsAt === null
              ? t('quota_resets.no_reset')
              : t('quota_resets.outside_span', {
                  time: formatInstant(lane.resetsAt, locale),
                })}
          </span>
        )}
        {bars.map((bar) => {
          const label = barLabel(bar);
          // Short windows are slivers at this scale: their label sits beside the bar.
          const outside = lane.usageTriggered && bar.state === 'live';
          const flip = bar.leftPercent + bar.widthPercent > 78;
          return (
            <span
              key={bar.startMs}
              className={styles.bar}
              data-state={bar.state}
              data-clip-start={bar.clippedStart || undefined}
              data-clip-end={bar.clippedEnd || undefined}
              style={{ left: `${bar.leftPercent}%`, width: `${bar.widthPercent}%` }}
              title={describe(bar)}
              role="img"
              aria-label={describe(bar)}
            >
              {bar.state === 'live' && bar.remaining !== null && (
                <span
                  className={styles.barMeter}
                  style={{ width: `${Math.max(0, Math.min(100, bar.remaining))}%` }}
                />
              )}
              {label && !outside && bar.widthPercent > 5 && (
                <span className={styles.barLabel}>{label}</span>
              )}
              {label && outside && (
                <span className={styles.barLabelOutside} data-flip={flip || undefined}>
                  {label}
                </span>
              )}
            </span>
          );
        })}
        {marks.map((mark) => {
          const title = t('quota_resets.credit_expires', {
            time: formatInstant(mark.expiresAt, locale),
            duration: formatDuration(mark.expiresAt - now),
          });
          return (
            <span
              key={mark.id || mark.expiresAt}
              className={styles.credit}
              style={{ left: `${mark.left}%` }}
              title={title}
              role="img"
              aria-label={title}
            />
          );
        })}
      </div>
    </div>
  );
}

/** "Nov 24, 3:00 PM" */
function formatInstant(ms: number, locale: string): string {
  return new Date(ms).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
