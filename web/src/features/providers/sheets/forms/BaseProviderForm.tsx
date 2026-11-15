import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  IconDownload,
  IconEye,
  IconEyeOff,
  IconLoader2,
  IconPlus,
  IconX,
} from '@/components/ui/icons';
import { Collapsible } from '@/components/ui/Collapsible';
import { Select } from '@/components/ui/Select';
import {
  DISABLE_ALL_RULE,
  ExcludedModelsPicker,
  formatExcludedRulesText,
  parseExcludedRulesText,
  type ExcludedModelsCatalogState,
} from '@/components/excludedModels';
import { hasDisableAllModelsRule } from '@/components/providers/utils';
import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import type { ModelInfo } from '@/utils/models';
import { PROVIDER_DESCRIPTORS } from '../../descriptors';
import { removeModelAt } from '../../modelEntries';
import { syncDiscoveredModels } from '../../discoverySelection';
import type {
  ApiKeyEntryInput,
  ModelEntryInput,
  ProviderBrand,
  ProviderEntryFormInput,
  ProviderResource,
} from '../../types';
import { useConnectivityTest, type ConnectivityErrorMessages } from './useConnectivityTest';
import { useModelDiscovery } from './useModelDiscovery';
import { ModelDiscoveryPanel } from './ModelDiscoveryPanel';
import { ConnectivityStatusIcon } from './ConnectivityStatusIcon';
import { ApiKeyEntriesEditor } from './ApiKeyEntriesEditor';
import { ModelEntriesEditor } from './ModelEntriesEditor';
import styles from './sharedForm.module.scss';
import { MAX_CREDENTIAL_WEIGHT } from '@/utils/credentialWeight';
import { readRuntimePolicy, validateRuntimePolicy } from '../../runtimePolicy';
import { readModelOptions, validateModelOptions } from '../../modelOptions';
import { RuntimePolicyEditor } from './RuntimePolicyEditor';
import { ProviderBehaviorEditor } from './ProviderBehaviorEditor';
import { pickProviderBehavior } from '../../providerBehavior';
import { recordConnectivity } from '../../connectivityLog';

/** Module-level constant so the picker does not get a new array reference on every render. */
const DISABLE_ALL_RULES = [DISABLE_ALL_RULE];

interface BaseProviderFormProps {
  brand: ProviderBrand;
  resource: ProviderResource | null;
  mode: 'create' | 'edit';
  /** Run the connectivity test once on mount (edit mode only). */
  autoTest?: boolean;
  mutating: boolean;
  formId: string;
  onSubmit: (input: ProviderEntryFormInput) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}

type FieldKey = 'name' | 'apiKey' | 'baseUrl' | 'weight';
type FormErrors = Partial<Record<FieldKey | 'form', string>>;

function FormSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {description ? <p className={styles.sectionDesc}>{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

const emptyHeader = () => ({ key: '', value: '' });
const emptyModel = (): ModelEntryInput => ({ name: '', alias: '' });
const emptyApiKeyEntry = (): ApiKeyEntryInput => ({
  apiKey: '',
  proxyUrl: '',
  weight: undefined,
});
const META_API_BASE_URL = 'https://api.meta.ai/v1';
const XAI_API_BASE_URL = 'https://api.x.ai/v1';

const stripDisableAllRule = (list?: string[]): string[] =>
  (list ?? []).filter((s) => s.trim() !== '*');

const formatJsonObject = (value?: Record<string, unknown>): string => {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value, null, 2);
};

const isClaudeLikeBrand = (brand: ProviderBrand): boolean => brand === 'claude';

function buildInitialForm(
  brand: ProviderBrand,
  resource: ProviderResource | null,
  mode: 'create' | 'edit'
): ProviderEntryFormInput {
  if (mode === 'create' || !resource) {
    return {
      apiKey: '',
      name: '',
      baseUrl: brand === 'meta' ? META_API_BASE_URL : brand === 'xai' ? XAI_API_BASE_URL : '',
      proxyUrl: '',
      prefix: '',
      disabled: false,
      disableCooling: undefined,
      runtimePolicy: readRuntimePolicy(),
      priority: undefined,
      weight: undefined,
      models: [emptyModel()],
      headers: [emptyHeader()],
      excludedModelsText: '',
      websockets: brand === 'codex' || brand === 'xai' ? false : undefined,
      cloak: isClaudeLikeBrand(brand)
        ? { mode: '', strictMode: false, sensitiveWordsText: '', cacheUserId: false }
        : undefined,
      fingerprintProfile: isClaudeLikeBrand(brand) ? '' : undefined,
      testModel:
        brand === 'openaiCompatibility' ||
        brand === 'codex' ||
        brand === 'meta' ||
        brand === 'xai' ||
        isClaudeLikeBrand(brand) ||
        brand === 'gemini' ||
        brand === 'interactions'
          ? ''
          : undefined,
      apiKeyEntries: brand === 'openaiCompatibility' ? [emptyApiKeyEntry()] : undefined,
    };
  }

  const raw = resource.raw;
  if (brand === 'openaiCompatibility') {
    const cfg = raw as OpenAIProviderConfig;
    return {
      apiKey: '',
      name: cfg.name ?? '',
      baseUrl: cfg.baseUrl ?? '',
      proxyUrl: '',
      prefix: cfg.prefix ?? '',
      disabled: cfg.disabled === true,
      disableCooling: cfg.disableCooling,
      runtimePolicy: readRuntimePolicy(cfg),
      ...pickProviderBehavior(cfg, brand),
      priority: cfg.priority,
      models: cfg.models?.length
        ? cfg.models.map((m) => ({
            sourceIndex: m.sourceIndex,
            name: m.name,
            alias: m.alias ?? '',
            priority: m.priority,
            image: m.image === true,
            thinkingJson: formatJsonObject(m.thinking),
            ...readModelOptions(m),
          }))
        : [emptyModel()],
      headers: cfg.headers
        ? Object.entries(cfg.headers).map(([k, v]) => ({ key: k, value: String(v) }))
        : [emptyHeader()],
      excludedModelsText: '',
      testModel: '',
      apiKeyEntries: cfg.apiKeyEntries?.length
        ? cfg.apiKeyEntries.map((entry) => ({
            apiKey: '',
            existingApiKey: entry.apiKey,
            sourceIndex: entry.sourceIndex,
            proxyUrl: entry.proxyUrl ?? '',
            weight: entry.weight,
            authIndex: entry.authIndex,
          }))
        : [emptyApiKeyEntry()],
    };
  }

  const cfg = raw as GeminiKeyConfig & ProviderKeyConfig;
  const disabled = hasDisableAllModelsRule(cfg.excludedModels);
  const excludedList = stripDisableAllRule(cfg.excludedModels);
  return {
    // Keep the API key blank in edit mode. Pre-filling the real key makes this
    // password field a browser-autofill target (the saved management key can
    // overwrite it) and defeats the "leave empty = keep unchanged" contract; an
    // empty field is preserved on save via buildProviderKeyConfig's existing fallback.
    apiKey: '',
    name: '',
    baseUrl: cfg.baseUrl ?? '',
    proxyUrl: cfg.proxyUrl ?? '',
    prefix: cfg.prefix ?? '',
    disabled,
    disableCooling: cfg.disableCooling,
    runtimePolicy: readRuntimePolicy(cfg),
    ...pickProviderBehavior(cfg, brand),
    priority: cfg.priority,
    weight: cfg.weight,
    models: cfg.models?.length
      ? cfg.models.map((m) => ({
          sourceIndex: m.sourceIndex,
          name: m.name,
          alias: m.alias ?? '',
          priority: m.priority,
          thinkingJson: formatJsonObject(m.thinking),
          ...readModelOptions(m),
        }))
      : [emptyModel()],
    headers: cfg.headers
      ? Object.entries(cfg.headers).map(([k, v]) => ({ key: k, value: String(v) }))
      : [emptyHeader()],
    excludedModelsText: excludedList.join('\n'),
    websockets:
      brand === 'codex' || brand === 'xai'
        ? (cfg as ProviderKeyConfig).websockets === true
        : undefined,
    cloak: isClaudeLikeBrand(brand)
      ? {
          mode: (cfg as ProviderKeyConfig).cloak?.mode ?? '',
          strictMode: (cfg as ProviderKeyConfig).cloak?.strictMode === true,
          sensitiveWordsText: (cfg as ProviderKeyConfig).cloak?.sensitiveWords?.join('\n') ?? '',
          cacheUserId: (cfg as ProviderKeyConfig).cloak?.cacheUserId === true,
        }
      : undefined,
    fingerprintProfile: isClaudeLikeBrand(brand)
      ? ((cfg as ProviderKeyConfig).fingerprintProfile ?? '')
      : undefined,
    testModel:
      brand === 'codex' ||
      brand === 'meta' ||
      brand === 'xai' ||
      isClaudeLikeBrand(brand) ||
      brand === 'gemini' ||
      brand === 'interactions'
        ? ''
        : undefined,
  };
}

export function BaseProviderForm({
  brand,
  resource,
  mode,
  autoTest = false,
  mutating,
  formId,
  onSubmit,
  onDirtyChange,
}: BaseProviderFormProps) {
  const { t } = useTranslation();
  const descriptor = PROVIDER_DESCRIPTORS[brand];
  const fid = useId();
  const [form, setForm] = useState<ProviderEntryFormInput>(() =>
    buildInitialForm(brand, resource, mode)
  );
  const [initialFormSignature] = useState<string>(() =>
    JSON.stringify(buildInitialForm(brand, resource, mode))
  );
  const [errors, setErrors] = useState<FormErrors>({});
  const [showSingleApiKey, setShowSingleApiKey] = useState(false);

  const isDirty = useMemo(
    () => JSON.stringify(form) !== initialFormSignature,
    [form, initialFormSignature]
  );

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const fallbackApiKey = useMemo(() => {
    if (mode !== 'edit' || !resource) return '';
    if (brand === 'openaiCompatibility') return '';
    return (resource.raw as { apiKey?: string } | undefined)?.apiKey ?? '';
  }, [brand, mode, resource]);

  const fallbackAuthIndex = useMemo(() => {
    if (mode !== 'edit' || !resource) return '';
    return (resource.raw as { authIndex?: string } | undefined)?.authIndex ?? '';
  }, [mode, resource]);

  const connectivityMessages = useMemo<ConnectivityErrorMessages>(
    () => ({
      baseUrlRequired: t('providersPage.connectivity.baseUrlRequired'),
      endpointInvalid: t('providersPage.connectivity.endpointInvalid'),
      apiKeyRequired: t('providersPage.connectivity.apiKeyRequired'),
      modelRequired: t('providersPage.connectivity.modelRequired'),
      timeout: (seconds: number) => t('providersPage.connectivity.timeout', { seconds }),
      requestFailed: t('providersPage.connectivity.requestFailed'),
    }),
    [t]
  );

  const connectivity = useConnectivityTest(
    {
      brand,
      baseUrl: form.baseUrl,
      proxyUrl: form.proxyUrl,
      testModel: form.testModel,
      models: form.models,
      formHeaders: form.headers,
      apiKeyEntries: form.apiKeyEntries,
      apiKey: form.apiKey,
      fallbackApiKey,
      authIndex: fallbackAuthIndex,
    },
    connectivityMessages
  );

  const discovery = useModelDiscovery({
    brand,
    baseUrl: form.baseUrl,
    proxyUrl: form.proxyUrl,
    formHeaders: form.headers,
    apiKeyEntries: form.apiKeyEntries,
    apiKey: form.apiKey,
    fallbackApiKey,
    authIndex: fallbackAuthIndex,
  });
  const [discoveryOpen, setDiscoveryOpen] = useState(false);

  const existingModelNames = useMemo(() => {
    const set = new Set<string>();
    form.models.forEach((m) => {
      const name = (m.name ?? '').trim();
      if (name) set.add(name);
    });
    return set;
  }, [form.models]);

  const testModelOptions = useMemo(() => {
    const seen = new Set<string>();
    const names: string[] = [];
    form.models.forEach((m) => {
      const name = (m.name ?? '').trim();
      if (!name || seen.has(name)) return;
      seen.add(name);
      names.push(name);
    });
    const firstName = names[0];
    const autoLabel = firstName
      ? t('providersPage.form.testModelAutoWith', { name: firstName })
      : t('providersPage.form.testModelAutoEmpty');
    const opts: Array<{ value: string; label: string }> = [{ value: '', label: autoLabel }];
    names.forEach((n) => opts.push({ value: n, label: n }));
    const tm = (form.testModel ?? '').trim();
    if (tm && !seen.has(tm)) {
      opts.push({
        value: tm,
        label: t('providersPage.form.testModelCustom', { name: tm }),
      });
    }
    return opts;
  }, [form.models, form.testModel, t]);

  const openDiscovery = () => {
    setDiscoveryOpen(true);
    if (!discovery.loading && !discovery.hasFetched) {
      void discovery.fetch();
    }
  };

  const closeDiscovery = () => {
    setDiscoveryOpen(false);
  };

  const applyDiscoveredModels = (picked: ModelInfo[], catalog: ModelInfo[]) => {
    setForm((prev) => ({ ...prev, models: syncDiscoveredModels(prev.models, picked, catalog) }));
  };

  const updateField = <K extends keyof ProviderEntryFormInput>(
    key: K,
    value: ProviderEntryFormInput[K]
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateCloak = <K extends keyof NonNullable<ProviderEntryFormInput['cloak']>>(
    key: K,
    value: NonNullable<ProviderEntryFormInput['cloak']>[K]
  ) => {
    setForm((prev) => ({
      ...prev,
      cloak: {
        ...(prev.cloak ?? {
          mode: '',
          strictMode: false,
          sensitiveWordsText: '',
          cacheUserId: false,
        }),
        [key]: value,
      },
    }));
  };

  const validate = (): FormErrors => {
    const modelError = validateModelOptions(form.models);
    if (modelError) return { form: t(modelError) };
    if (form.runtimePolicy) {
      const policyError = validateRuntimePolicy(
        form.runtimePolicy,
        descriptor.supportsRequestScopedErrors
      );
      if (policyError) return { form: t(policyError) };
    }
    const next: FormErrors = {};
    if (descriptor.supportsName && !form.name.trim()) {
      next.name = t('providersPage.form.validation.nameRequired');
    }
    if (descriptor.supportsApiKey && mode === 'create' && !form.apiKey.trim()) {
      next.apiKey = t('providersPage.form.validation.apiKeyRequired');
    }
    if (descriptor.baseUrlRequired && !form.baseUrl.trim()) {
      next.baseUrl = t('providersPage.form.validation.baseUrlRequired');
    }
    const weights = [
      ...(brand === 'openaiCompatibility'
        ? (form.apiKeyEntries ?? []).map((entry) => entry.weight)
        : []),
      ...(brand !== 'openaiCompatibility' ? [form.weight] : []),
    ];
    const weightTarget: FieldKey | 'form' = brand === 'openaiCompatibility' ? 'form' : 'weight';
    if (weights.some((weight) => weight !== undefined && !Number.isSafeInteger(weight))) {
      next[weightTarget] = t('providersPage.form.validation.weightInteger');
    } else if (weights.some((weight) => weight !== undefined && weight > MAX_CREDENTIAL_WEIGHT)) {
      next[weightTarget] = t('providersPage.form.validation.weightMax', {
        max: MAX_CREDENTIAL_WEIGHT,
      });
    }
    return next;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      const first = (['name', 'apiKey', 'baseUrl', 'weight'] as const).find((key) => found[key]);
      if (first) document.getElementById(`${fid}-${first}`)?.focus();
      return;
    }
    try {
      await onSubmit(form);
    } catch (err) {
      setErrors({ form: err instanceof Error ? err.message : String(err) });
    }
  };

  const fieldError = (key: FieldKey) =>
    errors[key] ? (
      <span id={`${fid}-${key}-error`} className={styles.fieldError} role="alert">
        {errors[key]}
      </span>
    ) : null;
  const invalidProps = (key: FieldKey) =>
    errors[key] ? { 'aria-invalid': true as const, 'aria-describedby': `${fid}-${key}-error` } : {};
  const clearError = (key: FieldKey) =>
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });

  /* ------------------ entries helpers ------------------ */

  const headersList = useMemo(
    () => (form.headers.length ? form.headers : [emptyHeader()]),
    [form.headers]
  );
  const modelsList = useMemo(
    () => (form.models.length ? form.models : [emptyModel()]),
    [form.models]
  );
  const apiKeyEntries = useMemo(
    () =>
      form.apiKeyEntries && form.apiKeyEntries.length ? form.apiKeyEntries : [emptyApiKeyEntry()],
    [form.apiKeyEntries]
  );

  const excludedRules = useMemo(
    () => parseExcludedRulesText(form.excludedModelsText),
    [form.excludedModelsText]
  );
  /**
   * Candidate catalog = models found by discovery plus model names already in the form.
   *
   * Both can be empty: `vertex` supports excluded models but is not in MODEL_DISCOVERY_BRANDS,
   * so it never has discovery, and other brands have none until discovery is run. No catalog
   * is the normal case, so the picker must fall back to a plain rule editor.
   */
  const excludedCandidates = useMemo(() => {
    const byKey = new Map<string, { id: string; displayName?: string }>();
    discovery.models.forEach((model) => {
      const id = model.name?.trim();
      if (id) byKey.set(id.toLowerCase(), { id, displayName: model.alias || undefined });
    });
    form.models.forEach((model) => {
      const id = model.name?.trim();
      if (id && !byKey.has(id.toLowerCase())) byKey.set(id.toLowerCase(), { id });
    });
    return [...byKey.values()].sort((left, right) =>
      left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
    );
  }, [discovery.models, form.models]);
  const excludedCatalogState: ExcludedModelsCatalogState = discovery.loading
    ? 'loading'
    : discovery.error
      ? 'error'
      : excludedCandidates.length === 0
        ? 'unavailable'
        : 'ready';
  const actualApiKeyEntries = form.apiKeyEntries ?? [];
  const supportsModelImage = brand === 'openaiCompatibility';
  const singleConnectivity =
    brand === 'codex' || brand === 'meta' || brand === 'xai'
      ? { status: connectivity.codexStatus, run: connectivity.runCodex }
      : brand === 'gemini' || brand === 'interactions'
        ? { status: connectivity.geminiStatus, run: connectivity.runGemini }
        : isClaudeLikeBrand(brand)
          ? { status: connectivity.claudeStatus, run: connectivity.runClaude }
          : null;

  // Remember the latest finished test for the list's "Last test" column.
  const resourceId = mode === 'edit' ? (resource?.id ?? null) : null;
  const singleState = singleConnectivity?.status.state;
  const singleMessage = singleConnectivity?.status.message ?? '';
  useEffect(() => {
    if (!resourceId || !singleState) return;
    if (singleState !== 'success' && singleState !== 'error') return;
    recordConnectivity(resourceId, {
      ok: singleState === 'success',
      message: singleMessage,
      at: Date.now(),
    });
  }, [resourceId, singleState, singleMessage]);
  const { openaiStatuses } = connectivity;
  useEffect(() => {
    if (!resourceId || brand !== 'openaiCompatibility') return;
    const finished = openaiStatuses.filter((s) => s.state === 'success' || s.state === 'error');
    if (finished.length === 0 || openaiStatuses.some((s) => s.state === 'loading')) return;
    const failed = finished.find((s) => s.state === 'error');
    recordConnectivity(resourceId, {
      ok: !failed,
      message: failed?.message ?? '',
      at: Date.now(),
    });
  }, [brand, openaiStatuses, resourceId]);

  // "Test connection" from the list opens the editor and runs the test once.
  const autoTestedRef = useRef(false);
  const runOpenAIAll = connectivity.runOpenAIAllKeys;
  const runSingle = singleConnectivity?.run;
  useEffect(() => {
    if (!autoTest || autoTestedRef.current) return;
    autoTestedRef.current = true;
    if (brand === 'openaiCompatibility') void runOpenAIAll();
    else if (runSingle) void runSingle();
  }, [autoTest, brand, runOpenAIAll, runSingle]);

  const updateModelEntry = (idx: number, patch: Partial<ModelEntryInput>) => {
    updateField(
      'models',
      modelsList.map((it, i) => (i === idx ? { ...it, ...patch } : it))
    );
  };

  const removeModelEntry = (idx: number) => {
    updateField('models', removeModelAt(modelsList, idx));
  };

  const hasRoutingFields = descriptor.supportsPrefix || brand !== 'openaiCompatibility';

  return (
    <form id={formId} className={styles.form} onSubmit={handleSubmit} noValidate>
      <FormSection title={t('providersPage.form.sections.connection')}>
        {descriptor.supportsName ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fid}-name`}>
              {t('providersPage.form.name')}
            </label>
            <input
              id={`${fid}-name`}
              className={styles.input}
              value={form.name}
              onChange={(e) => {
                updateField('name', e.target.value);
                clearError('name');
              }}
              disabled={mutating}
              {...invalidProps('name')}
            />
            <span className={styles.help}>{t('providersPage.form.nameHint')}</span>
            {fieldError('name')}
          </div>
        ) : null}

        {descriptor.supportsApiKey ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fid}-apiKey`}>
              {t('providersPage.form.apiKey')}
            </label>
            <div className={styles.passwordField}>
              <input
                id={`${fid}-apiKey`}
                className={styles.passwordInput}
                type={showSingleApiKey ? 'text' : 'password'}
                value={form.apiKey}
                onChange={(e) => {
                  updateField('apiKey', e.target.value);
                  clearError('apiKey');
                }}
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                placeholder={
                  mode === 'edit'
                    ? t('providersPage.form.apiKeyEditPlaceholder')
                    : t('providersPage.form.apiKeyCreatePlaceholder')
                }
                disabled={mutating}
                {...invalidProps('apiKey')}
              />
              <button
                type="button"
                className={styles.passwordToggle}
                onClick={() => setShowSingleApiKey((v) => !v)}
                disabled={mutating}
                aria-label={
                  showSingleApiKey
                    ? t('providersPage.form.hideApiKey')
                    : t('providersPage.form.showApiKey')
                }
                title={
                  showSingleApiKey
                    ? t('providersPage.form.hideApiKey')
                    : t('providersPage.form.showApiKey')
                }
              >
                {showSingleApiKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
            {fieldError('apiKey')}
          </div>
        ) : null}

        {descriptor.supportsBaseUrl ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fid}-baseUrl`}>
              {t('providersPage.form.baseUrl')}
            </label>
            <input
              id={`${fid}-baseUrl`}
              className={`${styles.input} ${styles.mono}`}
              value={form.baseUrl}
              onChange={(e) => {
                updateField('baseUrl', e.target.value);
                clearError('baseUrl');
              }}
              placeholder="https://api.example.com"
              spellCheck={false}
              disabled={mutating}
              {...invalidProps('baseUrl')}
            />
            <span className={styles.help}>
              {descriptor.baseUrlRequired
                ? t('providersPage.form.baseUrlRequiredHint')
                : t('providersPage.form.baseUrlOptionalHint')}
            </span>
            {fieldError('baseUrl')}
          </div>
        ) : null}

        {descriptor.supportsProxyUrl ? (
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fid}-proxy`}>
              {t('providersPage.form.proxyUrl')}
            </label>
            <input
              id={`${fid}-proxy`}
              className={`${styles.input} ${styles.mono}`}
              value={form.proxyUrl}
              onChange={(e) => updateField('proxyUrl', e.target.value)}
              placeholder="http://127.0.0.1:7890"
              spellCheck={false}
              disabled={mutating}
            />
            <span className={styles.help}>{t('providersPage.form.proxyUrlHint')}</span>
          </div>
        ) : null}

        {descriptor.supportsDisabled ? (
          <label className={styles.checkboxRow}>
            <input
              type="checkbox"
              className={styles.checkboxBox}
              checked={form.disabled}
              disabled={mutating}
              onChange={(e) => updateField('disabled', e.target.checked)}
            />
            <span className={styles.checkboxText}>
              <span>{t('providersPage.form.disabled')}</span>
              <small>{t('providersPage.form.disabledHint')}</small>
            </span>
          </label>
        ) : null}
      </FormSection>

      {descriptor.supportsApiKeyEntries && form.apiKeyEntries ? (
        <FormSection
          title={t('providersPage.form.apiKeyEntriesSection')}
          description={t('providersPage.form.apiKeyEntriesHint')}
        >
          <ApiKeyEntriesEditor
            entries={apiKeyEntries}
            removeDisabled={actualApiKeyEntries.length === 0}
            mutating={mutating}
            statuses={connectivity.openaiStatuses}
            isTestingAny={connectivity.isTestingAny}
            onUpdate={(idx, patch) =>
              updateField(
                'apiKeyEntries',
                apiKeyEntries.map((it, i) => (i === idx ? { ...it, ...patch } : it))
              )
            }
            onAdd={() => {
              const next = [...actualApiKeyEntries, emptyApiKeyEntry()];
              updateField('apiKeyEntries', next);
              return next.length - 1;
            }}
            onRemove={(idx) =>
              updateField(
                'apiKeyEntries',
                actualApiKeyEntries.filter((_, i) => i !== idx)
              )
            }
            onTest={(idx) => void connectivity.runOpenAIKey(idx)}
            onTestAll={() => void connectivity.runOpenAIAllKeys()}
          />
        </FormSection>
      ) : null}

      {descriptor.supportsTestModel ? (
        <FormSection
          title={t('providersPage.form.sections.test')}
          description={t('providersPage.form.sections.testHint')}
        >
          <div className={styles.field}>
            <label className={styles.label} htmlFor={`${fid}-testModel`}>
              {t('providersPage.form.testModel')}
            </label>
            <Select
              id={`${fid}-testModel`}
              value={form.testModel ?? ''}
              options={testModelOptions}
              onChange={(value) => updateField('testModel', value)}
              disabled={mutating}
              ariaLabel={t('providersPage.form.testModel')}
            />
            <span className={styles.help}>{t('providersPage.form.testModelHint')}</span>
          </div>
          {singleConnectivity ? (
            <div className={styles.field}>
              <div className={styles.connectivityRow}>
                <button
                  type="button"
                  className={styles.connectivityBtn}
                  disabled={mutating || connectivity.isTestingAny}
                  onClick={() => void singleConnectivity.run()}
                >
                  {singleConnectivity.status.state === 'loading' ? (
                    <span className={`${styles.statusIcon} ${styles.statusIconLoading}`}>
                      <IconLoader2 size={14} />
                    </span>
                  ) : null}
                  <span>{t('providersPage.connectivity.test')}</span>
                </button>
                <ConnectivityStatusIcon state={singleConnectivity.status.state} />
                {singleConnectivity.status.state === 'success' ? (
                  <span className={styles.connectivityHintSuccess}>
                    {t('providersPage.connectivity.success')}
                  </span>
                ) : null}
              </div>
              {singleConnectivity.status.state === 'error' ? (
                <div className={styles.connectivityError} role="alert">
                  {singleConnectivity.status.message}
                </div>
              ) : null}
            </div>
          ) : null}
        </FormSection>
      ) : null}

      {descriptor.supportsModels ? (
        <FormSection
          title={t('providersPage.form.modelsSection')}
          description={t('providersPage.form.modelsHint', { count: existingModelNames.size })}
        >
          <div className={styles.entriesList}>
            {discovery.available ? (
              <div className={styles.entriesToolbar}>
                <button
                  type="button"
                  className={styles.connectivityBtn}
                  onClick={openDiscovery}
                  disabled={mutating}
                >
                  <IconDownload size={14} />
                  <span>{t('providersPage.discovery.openButton')}</span>
                </button>
              </div>
            ) : null}
            {discovery.available && discoveryOpen ? (
              <ModelDiscoveryPanel
                loading={discovery.loading}
                error={discovery.error}
                models={discovery.models}
                hasFetched={discovery.hasFetched}
                existingNames={existingModelNames}
                mutating={mutating}
                onApply={applyDiscoveredModels}
                onReload={() => void discovery.fetch()}
                onClose={closeDiscovery}
              />
            ) : null}
            <ModelEntriesEditor
              providerBrand={brand}
              models={modelsList}
              supportsImage={supportsModelImage}
              supportsThinking
              mutating={mutating}
              removeDisabled={false}
              onUpdate={updateModelEntry}
              onAdd={() => updateField('models', [...modelsList, emptyModel()])}
              onRemove={removeModelEntry}
            />
          </div>
        </FormSection>
      ) : null}

      {hasRoutingFields ? (
        <FormSection
          title={t('providersPage.form.sections.routing')}
          description={t('providersPage.form.sections.routingHint')}
        >
          {descriptor.supportsPrefix ? (
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label} htmlFor={`${fid}-prefix`}>
                  {t('providersPage.form.prefix')}
                </label>
                <input
                  id={`${fid}-prefix`}
                  className={styles.input}
                  value={form.prefix}
                  onChange={(e) => updateField('prefix', e.target.value)}
                  disabled={mutating}
                />
                <span className={styles.help}>{t('providersPage.form.prefixHint')}</span>
              </div>
              {descriptor.supportsPriority ? (
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${fid}-prio`}>
                    {t('providersPage.form.priority')}
                  </label>
                  <input
                    id={`${fid}-prio`}
                    type="number"
                    className={styles.input}
                    value={form.priority ?? ''}
                    onChange={(e) =>
                      updateField(
                        'priority',
                        e.target.value === '' ? undefined : Number(e.target.value)
                      )
                    }
                    disabled={mutating}
                  />
                  <span className={styles.help}>{t('providersPage.form.priorityHint')}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {brand !== 'openaiCompatibility' ? (
            <div className={styles.field}>
              <label className={styles.label} htmlFor={`${fid}-weight`}>
                {t('providersPage.form.weight')}
              </label>
              <input
                id={`${fid}-weight`}
                type="number"
                step="1"
                max={MAX_CREDENTIAL_WEIGHT}
                className={styles.input}
                value={form.weight ?? ''}
                placeholder="1"
                onChange={(e) => {
                  updateField('weight', e.target.value === '' ? undefined : Number(e.target.value));
                  clearError('weight');
                }}
                disabled={mutating}
                {...invalidProps('weight')}
              />
              <span className={styles.help}>{t('providersPage.form.weightHint')}</span>
              {fieldError('weight')}
            </div>
          ) : null}

          {descriptor.supportsWebsockets ? (
            <label className={styles.checkboxRow}>
              <input
                type="checkbox"
                className={styles.checkboxBox}
                checked={form.websockets ?? false}
                disabled={mutating}
                onChange={(e) => updateField('websockets', e.target.checked)}
              />
              <span className={styles.checkboxText}>
                <span>{t('providersPage.form.websockets')}</span>
              </span>
            </label>
          ) : null}
        </FormSection>
      ) : null}

      <FormSection title={t('providersPage.form.sections.advanced')}>
        <div className={styles.advanced}>
          <ProviderBehaviorEditor
            brand={brand}
            value={form}
            onChange={(patch) => setForm((current) => ({ ...current, ...patch }))}
            disabled={mutating}
          />
          <RuntimePolicyEditor
            value={form.runtimePolicy ?? readRuntimePolicy()}
            onChange={(value) => updateField('runtimePolicy', value)}
            disabled={mutating}
            supportsErrors={descriptor.supportsRequestScopedErrors}
          />

          {descriptor.supportsHeaders ? (
            <Collapsible label={t('providersPage.form.headersSection')}>
              <div className={styles.entriesList}>
                {headersList.map((entry, idx) => (
                  <div key={idx} className={styles.headerRow}>
                    <input
                      className={`${styles.input} ${styles.mono}`}
                      placeholder="X-Custom-Header"
                      aria-label={t('providersPage.form.headerName')}
                      value={entry.key}
                      onChange={(e) =>
                        updateField(
                          'headers',
                          headersList.map((it, i) =>
                            i === idx ? { ...it, key: e.target.value } : it
                          )
                        )
                      }
                      disabled={mutating}
                    />
                    <input
                      className={`${styles.input} ${styles.mono}`}
                      placeholder="value"
                      aria-label={t('providersPage.form.headerValue')}
                      value={entry.value}
                      onChange={(e) =>
                        updateField(
                          'headers',
                          headersList.map((it, i) =>
                            i === idx ? { ...it, value: e.target.value } : it
                          )
                        )
                      }
                      disabled={mutating}
                    />
                    <button
                      type="button"
                      className={styles.removeBtn}
                      aria-label={t('providersPage.form.removeHeader')}
                      disabled={mutating || headersList.length <= 1}
                      onClick={() =>
                        updateField(
                          'headers',
                          headersList.filter((_, i) => i !== idx)
                        )
                      }
                    >
                      <IconX size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className={styles.addBtn}
                  disabled={mutating}
                  onClick={() => updateField('headers', [...headersList, emptyHeader()])}
                >
                  <IconPlus size={12} />
                  <span>{t('providersPage.form.addHeader')}</span>
                </button>
              </div>
            </Collapsible>
          ) : null}

          {descriptor.supportsExcludedModels ? (
            <Collapsible label={t('providersPage.form.excludedSection')}>
              <div className={styles.field}>
                <ExcludedModelsPicker
                  value={excludedRules}
                  onChange={(next) =>
                    updateField('excludedModelsText', formatExcludedRulesText(next))
                  }
                  candidates={excludedCandidates}
                  catalogState={excludedCatalogState}
                  onRetryCatalog={discovery.available ? () => void discovery.fetch() : undefined}
                  disabled={mutating}
                  // `'*'` means the provider is disabled; the Disabled checkbox above owns it.
                  // The picker filters it both ways and explains why when it is typed.
                  reservedRules={DISABLE_ALL_RULES}
                  reservedRuleMessage={t('providersPage.form.excludedDisabledNote')}
                />
              </div>
            </Collapsible>
          ) : null}

          {isClaudeLikeBrand(brand) ? (
            <Collapsible label={t('providersPage.form.fingerprintProfile')}>
              <div className={styles.field}>
                <Select
                  id={`${fid}-fingerprint-profile`}
                  value={form.fingerprintProfile ?? ''}
                  options={[
                    {
                      value: '',
                      label: t('providersPage.form.fingerprintProfileDefault'),
                    },
                    {
                      value: 'claude-code-cli',
                      label: t('providersPage.form.fingerprintProfileClaudeCodeCli'),
                    },
                  ]}
                  onChange={(value) => updateField('fingerprintProfile', value)}
                  disabled={mutating}
                  ariaLabel={t('providersPage.form.fingerprintProfile')}
                />
                <span className={styles.help}>
                  {t('providersPage.form.fingerprintProfileHint')}
                </span>
              </div>
            </Collapsible>
          ) : null}

          {descriptor.supportsCloak && form.cloak ? (
            <Collapsible label={t('providersPage.form.cloakSection')}>
              <div className={styles.section}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${fid}-cloak-mode`}>
                    {t('providersPage.form.cloakMode')}
                  </label>
                  <input
                    id={`${fid}-cloak-mode`}
                    className={styles.input}
                    value={form.cloak.mode}
                    onChange={(e) => updateCloak('mode', e.target.value)}
                    placeholder="auto / always / never"
                    disabled={mutating}
                  />
                </div>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    className={styles.checkboxBox}
                    checked={form.cloak.strictMode}
                    disabled={mutating}
                    onChange={(e) => updateCloak('strictMode', e.target.checked)}
                  />
                  <span className={styles.checkboxText}>
                    <span>{t('providersPage.form.cloakStrict')}</span>
                  </span>
                </label>
                <label className={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    className={styles.checkboxBox}
                    checked={form.cloak.cacheUserId}
                    disabled={mutating}
                    onChange={(e) => updateCloak('cacheUserId', e.target.checked)}
                  />
                  <span className={styles.checkboxText}>
                    <span>{t('providersPage.form.cloakCacheUserId')}</span>
                    <small>{t('providersPage.form.cloakCacheUserIdHint')}</small>
                  </span>
                </label>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`${fid}-cloak-words`}>
                    {t('providersPage.form.cloakSensitiveWords')}
                  </label>
                  <textarea
                    id={`${fid}-cloak-words`}
                    className={styles.textarea}
                    rows={3}
                    value={form.cloak.sensitiveWordsText}
                    onChange={(e) => updateCloak('sensitiveWordsText', e.target.value)}
                    disabled={mutating}
                  />
                </div>
              </div>
            </Collapsible>
          ) : null}
        </div>
      </FormSection>

      {errors.form ? (
        <div className={styles.errorBox} role="alert">
          {errors.form}
        </div>
      ) : null}
    </form>
  );
}
