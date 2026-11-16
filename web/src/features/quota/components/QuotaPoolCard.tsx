/**
 * One provider's pooled quota: a section with the window picker, a panel
 * holding the headline, projection stats, chart and legend, then the
 * per-account table. All numbers come from the pure pool model (poolModel.ts).
 *
 * Pools are capacity-weighted by plan and read in percent of the heaviest plan
 * in the pool: with a Max 5x and a Pro account, Max 5x is 100% and Pro 20%, so
 * the pool holds 120% ("38% of 120%"); each account's share is the table's
 * Capacity column. Weights come from the hub when it serves them and the
 * editor behind the card's sliders button writes them back; on an older hub
 * they stay in this browser.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button, IconButton } from '@/components/ui/Button';
import { IconSlidersHorizontal } from '@/components/ui/icons';
import { Section } from '@/components/ui/Section';
import { Skeleton } from '@/components/ui/Skeleton';
import { Stat } from '@/components/ui/Stat';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/Tabs';
import type { QuotaHistory } from '@/services/api';
import type { ResolvedTheme } from '@/types';
import { getAuthFileIcon, getTypeColor, getTypeLabel } from '@/features/authFiles/constants';
import { isValidPlanWeight, PLAN_WEIGHT_MAX, PLAN_WEIGHT_MIN } from '@/services/api/planWeights';
import {
  buildPoolView,
  isLivePoolProvider,
  type FutureUsage,
  type PlanWeights,
  type PoolProvider,
  type PoolWindowChoice,
} from '../poolModel';
import { formatDuration, formatMonthDay, formatWeekdayTime, POOL_UNITS } from '../poolFormat';
import { formatPlanName, formatWeight, planKey } from '../poolPrefs';
import { groupWindowChoices, windowLabel } from '../poolWindowLabels';
import type { PlanWeightsMode } from '../hooks/usePlanWeights';
import { PoolChart, type PoolChartMode } from './PoolChart';
import styles from './QuotaPoolCard.module.scss';

export interface QuotaPoolCardProps {
  provider: PoolProvider;
  history: QuotaHistory;
  window: PoolWindowChoice;
  /** Choices for the window picker; hidden when there is only one. */
  windowChoices: readonly PoolWindowChoice[];
  /** Names the provider gives its own windows, by window key. */
  windowLabels?: Record<string, string>;
  onWindowChange: (window: PoolWindowChoice) => void;
  /** Effective plan weights (plan → weight). */
  weights: PlanWeights;
  /** Hub defaults per plan; empty when the hub does not report them. */
  defaultWeights?: PlanWeights;
  /** Plans with a saved override. */
  configuredWeights?: PlanWeights;
  /** Where weights come from: the hub, this browser (older hub), or still loading. */
  weightsMode: PlanWeightsMode;
  weightsError?: string;
  /** Save edits: a weight, or null to go back to the default. Rejects on failure. */
  onSaveWeights: (changes: Record<string, number | null>) => Promise<void>;
  mode: PoolChartMode;
  showAccounts: boolean;
  spanStart: number;
  spanEnd: number;
  now: number;
  burnWindowHours: number;
  futureUsage: FutureUsage;
  resolvedTheme: ResolvedTheme;
  locale: string;
  /** Number of signed-in accounts for this provider (shown before readings arrive). */
  accountCount: number;
  /** First load: history still on its way and no live reading yet. */
  loading?: boolean;
  /** Newest recorded reading; null hides the line (live-only view). */
  lastReadAt?: number | null;
  stale?: boolean;
  /** A line under the headline, e.g. money spent in a window with a budget. */
  headlineHint?: string;
  /** Codex: banked resets over all accounts; null while unknown. */
  bankedResets?: number | null;
  /** Per-account table. */
  table?: ReactNode;
  /** Read every account's quota now; offered while the card has no reading. */
  onReadNow?: () => void;
  /** A read started from this card is running. */
  reading?: boolean;
}

/** More window choices than this switch the picker to a menu so it fits narrow screens. */
const MAX_SEGMENTED_WINDOWS = 3;

const formatClock = (ms: number, locale: string) =>
  new Date(ms).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });

export function QuotaPoolCard(props: QuotaPoolCardProps) {
  const {
    provider,
    history,
    window: windowChoice,
    windowChoices,
    windowLabels,
    onWindowChange,
    weights,
    defaultWeights = {},
    configuredWeights = {},
    weightsMode,
    weightsError = '',
    onSaveWeights,
    mode,
    showAccounts,
    spanStart,
    spanEnd,
    now,
    burnWindowHours,
    futureUsage,
    resolvedTheme,
    locale,
    accountCount,
    loading = false,
    lastReadAt = null,
    stale = false,
    bankedResets,
    headlineHint,
    table,
    onReadNow,
    reading = false,
  } = props;
  const { t } = useTranslation();
  const [weightsOpen, setWeightsOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const weightsRef = useRef<HTMLDivElement>(null);

  const view = useMemo(
    () =>
      buildPoolView(history, {
        provider,
        window: windowChoice,
        weights,
        now,
        spanStart,
        spanEnd,
        burnWindowHours,
        futureUsage,
      }),
    [
      burnWindowHours,
      futureUsage,
      history,
      now,
      provider,
      spanEnd,
      spanStart,
      weights,
      windowChoice,
    ]
  );

  const plans = useMemo(() => {
    const set = new Set<string>();
    history.accounts
      .filter((account) => account.provider === provider && !account.disabled && account.plan)
      .forEach((account) => set.add(planKey(account.plan as string)));
    return [...set].sort();
  }, [history.accounts, provider]);

  const units = POOL_UNITS;
  const single = view.tracks.length === 1;

  const currentWeight = (plan: string) => weights[plan] ?? defaultWeights[plan] ?? 1;
  const openWeights = () => {
    setDraft(Object.fromEntries(plans.map((plan) => [plan, String(currentWeight(plan))])));
    setSaveError('');
    setWeightsOpen(true);
  };
  const changes: Record<string, number | null> = {};
  let draftInvalid = false;
  plans.forEach((plan) => {
    const raw = draft[plan];
    if (raw === undefined) return;
    const value = Number(raw);
    if (raw.trim() === '' || !isValidPlanWeight(value)) {
      draftInvalid = true;
      return;
    }
    if (value === currentWeight(plan)) return;
    changes[plan] =
      defaultWeights[plan] !== undefined && value === defaultWeights[plan] ? null : value;
  });
  const dirty = Object.keys(changes).length > 0;
  const overridden = plans.filter((plan) => configuredWeights[plan] !== undefined);
  const editable = weightsMode === 'hub' || weightsMode === 'local';

  const runSave = async (next: Record<string, number | null>) => {
    setSaving(true);
    setSaveError('');
    try {
      await onSaveWeights(next);
      setWeightsOpen(false);
    } catch (error: unknown) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  const submitWeights = (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || draftInvalid || saving) return;
    void runSave(changes);
  };

  useEffect(() => {
    if (!weightsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!weightsRef.current?.contains(event.target as Node)) setWeightsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setWeightsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [weightsOpen]);

  const icon = getAuthFileIcon(provider, resolvedTheme);
  // Claude and Codex colours live in the stylesheet; other providers use their brand colour.
  const poolStyle = isLivePoolProvider(provider)
    ? undefined
    : ({ '--pool-color': getTypeColor(provider, resolvedTheme).text } as CSSProperties);
  const providerLabel = getTypeLabel(t, provider);
  const notBy = t('quota_pool.not_by', { date: formatMonthDay(spanEnd, locale) });

  const hasData = view.tracks.length > 0;
  const firstEmptyValue = view.firstEmpty ? (
    <>
      <span className={styles.label} data-sensitive title={view.firstEmpty.label}>
        {view.firstEmpty.label}
      </span>{' '}
      {view.firstEmpty.at <= now
        ? t('quota_pool.empty_now')
        : t('quota_pool.in_duration', { duration: formatDuration(view.firstEmpty.at - now) })}
    </>
  ) : (
    notBy
  );

  const currentWindowLabel = windowLabel(t, windowChoice, windowLabels);
  // Many scoped windows (Antigravity): a group picker plus short period tabs.
  const windowGroups = groupWindowChoices(t, windowChoices, windowLabels);
  const currentItem = windowGroups?.items.find((item) => item.choice === windowChoice);
  const currentGroup = currentItem?.group ?? windowGroups?.groups[0] ?? '';
  const groupItems = windowGroups
    ? windowGroups.items.filter((item) => (item.group ?? '') === currentGroup)
    : [];
  const selectGroup = (group: string) => {
    if (!windowGroups) return;
    const inGroup = windowGroups.items.filter((item) => (item.group ?? '') === group);
    // Keep the period the user is looking at when the new group has it.
    const same = inGroup.find((item) => item.period === currentItem?.period);
    const next = same ?? inGroup[0];
    if (next) onWindowChange(next.choice);
  };
  const stats: { key: string; label: string; value: ReactNode }[] = [
    {
      key: 'pool-empty',
      label: t(
        view.burnEstimate.confidence === 'limited'
          ? 'quota_pool.stat_pool_empty_limited'
          : 'quota_pool.stat_pool_empty'
      ),
      value: !hasData
        ? '—'
        : !view.burnEstimate.ready && futureUsage !== 'none'
          ? t('quota_pool.collecting_data')
          : view.poolEmptyAt !== null
            ? formatWeekdayTime(view.poolEmptyAt, locale)
            : notBy,
    },
    {
      key: 'first-empty',
      label: t('quota_pool.stat_first_empty'),
      value: !hasData
        ? '—'
        : !view.burnEstimate.ready && futureUsage !== 'none'
          ? t('quota_pool.collecting_data')
          : firstEmptyValue,
    },
    {
      key: 'next-reset',
      label: t('quota_pool.stat_next_reset'),
      value: view.nextReset
        ? `${units.signed(view.nextReset.amount)}, ${formatWeekdayTime(view.nextReset.at, locale)}`
        : '—',
    },
    {
      key: 'burn',
      label: t(
        view.burnEstimate.confidence === 'limited'
          ? 'quota_pool.stat_burn_limited'
          : 'quota_pool.stat_burn',
        {
          hours: Number(view.burnEstimate.windowHours.toFixed(1)),
        }
      ),
      value: !hasData
        ? '—'
        : view.burnEstimate.ready
          ? units.rate(view.burnRate)
          : t('quota_pool.collecting_data'),
    },
  ];
  // With one account the first account to run dry is the pool itself.
  if (single)
    stats.splice(
      stats.findIndex((stat) => stat.key === 'first-empty'),
      1
    );
  if (bankedResets !== undefined) {
    stats.push({
      key: 'banked',
      label: t('quota_pool.stat_banked'),
      value: bankedResets === null ? '—' : String(bankedResets),
    });
  }

  const description = (
    <span className={styles.meta}>
      <span>{t('quota_pool.accounts_count', { count: accountCount })}</span>
      {lastReadAt !== null && (
        <span>{t('quota_pool.last_reading', { time: formatClock(lastReadAt, locale) })}</span>
      )}
      {stale && lastReadAt !== null && (
        <Badge tone="warning" title={t('quota_pool.stale_hint')}>
          {t('quota_pool.stale', { duration: formatDuration(now - lastReadAt) })}
        </Badge>
      )}
    </span>
  );

  return (
    <Section
      className={styles.pool}
      title={
        <span className={styles.title}>
          {icon && <img src={icon} alt="" className={styles.icon} />}
          {providerLabel}
        </span>
      }
      description={description}
      actions={
        <div className={styles.headControls}>
          {windowGroups ? (
            <>
              <Select
                className={styles.windowSelect}
                fullWidth={false}
                size="sm"
                ariaLabel={t('quota_pool.window_group_label')}
                value={currentGroup}
                options={windowGroups.groups.map((group) => ({
                  value: group,
                  label: group || t('quota_pool.window_group_account'),
                }))}
                onChange={selectGroup}
              />
              {groupItems.length > 1 && (
                <SegmentedControl
                  ariaLabel={t('quota_pool.window_label')}
                  size="sm"
                  items={groupItems.map((item) => ({ value: item.choice, label: item.period }))}
                  value={windowChoice}
                  onChange={onWindowChange}
                />
              )}
            </>
          ) : windowChoices.length > MAX_SEGMENTED_WINDOWS ? (
            <Select
              className={styles.windowSelect}
              fullWidth={false}
              size="sm"
              ariaLabel={t('quota_pool.window_label')}
              value={windowChoice}
              options={windowChoices.map((choice) => ({
                value: choice,
                label: windowLabel(t, choice, windowLabels),
              }))}
              onChange={onWindowChange}
            />
          ) : windowChoices.length > 1 ? (
            <SegmentedControl
              ariaLabel={t('quota_pool.window_label')}
              size="sm"
              items={windowChoices.map((choice) => ({
                value: choice,
                label: windowLabel(t, choice, windowLabels),
              }))}
              value={windowChoice}
              onChange={onWindowChange}
            />
          ) : null}
          <div className={styles.weightsAnchor} ref={weightsRef}>
            <IconButton
              size="sm"
              aria-label={t('quota_pool.plan_weights_for', { provider: providerLabel })}
              title={t('quota_pool.plan_weights')}
              aria-expanded={weightsOpen}
              aria-haspopup="dialog"
              icon={<IconSlidersHorizontal size={16} />}
              onClick={() => (weightsOpen ? setWeightsOpen(false) : openWeights())}
            />
            {weightsOpen && (
              <form
                className={styles.weightsPopover}
                role="dialog"
                aria-label={t('quota_pool.plan_weights_for', { provider: providerLabel })}
                onSubmit={submitWeights}
              >
                <div className={styles.weightsTitle}>{t('quota_pool.plan_weights')}</div>
                <p className={styles.weightsHint}>
                  {t('quota_pool.plan_weights_hint')}{' '}
                  {weightsMode === 'local'
                    ? t('quota_pool.plan_weights_local')
                    : t('quota_pool.plan_weights_hub')}
                </p>
                {weightsMode === 'error' && (
                  <p className={styles.weightsError} role="alert">
                    {t('quota_pool.plan_weights_load_failed', { message: weightsError })}
                  </p>
                )}
                {weightsMode === 'loading' && (
                  <p className={styles.weightsHint}>{t('quota_pool.plan_weights_loading')}</p>
                )}
                {plans.length === 0 ? (
                  <p className={styles.weightsHint}>{t('quota_pool.plan_weights_empty')}</p>
                ) : (
                  plans.map((plan) => {
                    const fallback = defaultWeights[plan];
                    const inputId = `pool-weight-${provider}-${plan}`;
                    const raw = draft[plan] ?? String(currentWeight(plan));
                    const invalid = raw.trim() === '' || !isValidPlanWeight(Number(raw));
                    return (
                      <div key={plan} className={styles.weightRow}>
                        <label htmlFor={inputId} className={styles.weightPlan}>
                          <span>{formatPlanName(plan)}</span>
                          {fallback !== undefined && (
                            <span className={styles.weightDefault}>
                              {t('quota_pool.plan_weight_default', {
                                weight: formatWeight(fallback),
                              })}
                            </span>
                          )}
                        </label>
                        <span className={styles.weightInputWrap}>
                          <input
                            id={inputId}
                            type="number"
                            inputMode="decimal"
                            min={PLAN_WEIGHT_MIN}
                            max={PLAN_WEIGHT_MAX}
                            step="any"
                            className={`input ${styles.weightInput}`}
                            value={raw}
                            disabled={!editable || saving}
                            aria-invalid={invalid || undefined}
                            onChange={(event) =>
                              setDraft((previous) => ({ ...previous, [plan]: event.target.value }))
                            }
                          />
                          <span aria-hidden="true">×</span>
                        </span>
                      </div>
                    );
                  })
                )}
                {draftInvalid && (
                  <p className={styles.weightsError} role="alert">
                    {t('quota_pool.plan_weights_invalid', {
                      min: PLAN_WEIGHT_MIN,
                      max: PLAN_WEIGHT_MAX,
                    })}
                  </p>
                )}
                {saveError && (
                  <p className={styles.weightsError} role="alert">
                    {t('quota_pool.plan_weights_save_failed', { message: saveError })}
                  </p>
                )}
                {editable && plans.length > 0 && (
                  <div className={styles.weightsActions}>
                    {overridden.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={saving}
                        onClick={() =>
                          void runSave(Object.fromEntries(overridden.map((plan) => [plan, null])))
                        }
                      >
                        {weightsMode === 'hub'
                          ? t('quota_pool.plan_weights_reset_defaults')
                          : t('quota_pool.plan_weights_reset')}
                      </Button>
                    )}
                    <Button
                      type="submit"
                      variant="primary"
                      size="sm"
                      disabled={!dirty || draftInvalid}
                      loading={saving}
                    >
                      {t('quota_pool.plan_weights_save')}
                    </Button>
                  </div>
                )}
              </form>
            )}
          </div>
        </div>
      }
    >
      <div
        className={styles.panel}
        data-provider={provider}
        style={poolStyle}
        role="group"
        aria-label={t('quota_pool.card_label', { provider: providerLabel })}
      >
        {/* Nothing read yet: the empty-state panel alone, no row of dashes. */}
        {(hasData || loading) && (
          <div className={styles.stats}>
            <Stat
              size="lg"
              className={styles.headline}
              label={t('quota_pool.headline_label', { window: currentWindowLabel })}
              value={
                loading ? (
                  <Skeleton width={96} height={32} />
                ) : hasData ? (
                  units.value(view.current)
                ) : (
                  '—'
                )
              }
              unit={
                // One account: "38%" says it all; "of 100%" adds nothing.
                !hasData || single
                  ? undefined
                  : t('quota_pool.of_max', { max: units.value(view.max) })
              }
              hint={hasData && !loading ? headlineHint : undefined}
            />
            <div className={styles.statRow}>
              {stats.map((stat) => (
                <Stat
                  key={stat.key}
                  label={stat.label}
                  value={stat.value}
                  className={styles.stat}
                />
              ))}
            </div>
          </div>
        )}

        {loading ? (
          <Skeleton height={280} rounded={6} />
        ) : !hasData ? (
          <div className={styles.noData}>
            <span>{onReadNow ? t('quota_pool.no_reading') : t('quota_pool.no_samples')}</span>
            {onReadNow && (
              <Button variant="secondary" size="sm" loading={reading} onClick={onReadNow}>
                {t('quota_pool.read_now')}
              </Button>
            )}
          </div>
        ) : (
          <PoolChart
            view={view}
            mode={mode}
            showAccounts={showAccounts}
            spanStart={spanStart}
            spanEnd={spanEnd}
            now={now}
            locale={locale}
            units={units}
          />
        )}

        {hasData && !loading && (
          <ul className={styles.legend} aria-label={t('quota_pool.legend_label')}>
            <li className={styles.legendItem}>
              <span className={styles.swatchSolid} aria-hidden="true" />
              {mode === 'drain'
                ? t('quota_pool.legend_recorded_drain')
                : t('quota_pool.legend_recorded')}
            </li>
            <li className={styles.legendItem}>
              <span className={styles.swatchDashed} aria-hidden="true" />
              {mode === 'drain'
                ? t('quota_pool.legend_projected_drain')
                : t('quota_pool.legend_projected')}
            </li>
            {showAccounts && (
              <li className={styles.legendItem}>
                <span className={styles.swatchThin} aria-hidden="true" />
                {t('quota_pool.legend_accounts')}
              </li>
            )}
          </ul>
        )}
      </div>

      {table}
    </Section>
  );
}
