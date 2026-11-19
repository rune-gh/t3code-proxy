import type { VisualConfigFieldPath } from '@/types/visualConfig';
import type { VisualSectionId } from './searchIndex';

/** Editor mode: structured settings or the raw YAML source. */
export type ConfigEditorMode = 'visual' | 'source';

export type ConfigSectionId = VisualSectionId;

/** Sections a hub owner meets first, in page order. */
export const PRIMARY_SECTION_IDS = [
  'access',
  'management',
  'server',
  'routing',
  'quotaHistory',
  'logging',
] as const satisfies readonly VisualSectionId[];

/** The long tail, rendered inside the collapsed "Advanced" group. */
export const ADVANCED_SECTION_IDS = [
  'network',
  'streaming',
  'providers',
  'plugins',
  'payload',
  'discovery',
] as const satisfies readonly VisualSectionId[];

export const CONFIG_SECTION_IDS: readonly ConfigSectionId[] = [
  ...PRIMARY_SECTION_IDS,
  ...ADVANCED_SECTION_IDS,
];

const ADVANCED_SECTION_SET: ReadonlySet<string> = new Set(ADVANCED_SECTION_IDS);
export const isAdvancedSection = (id: ConfigSectionId) => ADVANCED_SECTION_SET.has(id);

/**
 * Validation field paths per section (navigation error counts).
 * Payload validation has no field path; the page adds it through hasPayloadValidationErrors.
 */
export const SECTION_VALIDATION_FIELDS: Record<VisualSectionId, readonly VisualConfigFieldPath[]> =
  {
    access: [],
    management: [],
    server: ['port', 'trustedProxies'],
    routing: [
      'requestRetry',
      'maxRetryCredentials',
      'maxRetryInterval',
      'transientErrorCooldownSeconds',
    ],
    quotaHistory: ['quotaHistoryInterval', 'quotaHistoryRetention'],
    logging: ['errorLogsMaxFiles', 'logsMaxTotalSizeMb', 'redisUsageQueueRetentionSeconds'],
    network: ['authAutoRefreshWorkers', 'videoResultAuthCacheTTL'],
    streaming: [
      'streaming.keepaliveSeconds',
      'streaming.bootstrapRetries',
      'streaming.nonstreamKeepaliveInterval',
    ],
    providers: [
      'claudeHeaderTimezone',
      'codexStreamBootstrapTimeout',
      'antigravityConnectionPoolIdleTimeout',
      'antigravityConnectionPoolMaxIdleConnsPerHost',
      'codexLiveMediaRelayMaxSessions',
      'codexLiveMediaRelayPublicIP',
      'codexLiveMediaRelayUDPPortMin',
      'codexLiveMediaRelayUDPPortMax',
      'codexLiveMediaRelayICEServers',
    ],
    plugins: [],
    payload: [],
    discovery: ['discoveryServiceType'],
  };

/**
 * Settings the backend reads only at startup (listener address, TLS, trusted proxies,
 * commercial-mode middleware). Their rows carry a "Restart required" marker.
 */
export const RESTART_REQUIRED_FIELD_IDS: ReadonlySet<string> = new Set([
  'host',
  'port',
  'tlsEnable',
  'tlsCert',
  'tlsKey',
  'trustedProxies',
  'commercialMode',
]);

/**
 * fieldId → useVisualConfig dirtyFields keys (VisualConfigValues leaf keys; streaming uses dotted
 * leaves). Mirrors the search index one to one; tests/configFieldParity.test.ts keeps the index,
 * this table and the section JSX in sync.
 */
export const FIELD_VALUE_KEYS: Record<string, readonly string[]> = {
  routingSessionAffinitySubagents: ['routingSessionAffinitySubagents'],
  saveCooldownStatus: ['saveCooldownStatus'],
  transientErrorCooldownSeconds: ['transientErrorCooldownSeconds'],
  videoResultAuthCacheTTL: ['videoResultAuthCacheTTL'],
  claudeHeaderTimezone: ['claudeHeaderTimezone'],
  claudeModelLevelCooling: ['claudeModelLevelCooling'],
  claudeDisableCloakMode: ['claudeDisableCloakMode'],
  claudeCodeDisableCloakingModelList: ['claudeCodeDisableCloakingModelList'],
  codexDisableCloaking: ['codexDisableCloaking'],
  codexModelLevelCooling: ['codexModelLevelCooling'],
  codexStreamBootstrapBuffering: ['codexStreamBootstrapBuffering'],
  codexStreamBootstrapTimeout: ['codexStreamBootstrapTimeout'],
  codexOptimizeMultiAgentV2: ['codexOptimizeMultiAgentV2'],
  codexOrphanDelegationCompatibility: ['codexOrphanDelegationCompatibility'],
  codexResponseSteering: ['codexResponseSteering'],
  antigravityConnectionPoolEnabled: ['antigravityConnectionPoolEnabled'],
  antigravityConnectionPoolIdleTimeout: ['antigravityConnectionPoolIdleTimeout'],
  antigravityConnectionPoolMaxIdleConnsPerHost: ['antigravityConnectionPoolMaxIdleConnsPerHost'],
  xaiInjectXSearch: ['xaiInjectXSearch'],
  codexLiveMediaRelayEnabled: ['codexLiveMediaRelayEnabled'],
  codexLiveMediaRelayMaxSessions: ['codexLiveMediaRelayMaxSessions'],
  codexLiveMediaRelayDisablePrivateRemoteIPs: ['codexLiveMediaRelayDisablePrivateRemoteIPs'],
  codexLiveMediaRelayPublicIP: ['codexLiveMediaRelayPublicIP'],
  codexLiveMediaRelayUDPPortMin: ['codexLiveMediaRelayUDPPortMin'],
  codexLiveMediaRelayUDPPortMax: ['codexLiveMediaRelayUDPPortMax'],
  codexLiveMediaRelayICEServers: ['codexLiveMediaRelayICEServers'],

  // ── server, management and discovery ──────────────────────────────────────
  githubToken: ['githubToken'],
  trustedProxies: ['trustedProxies'],
  discoveryEnabled: ['discoveryEnabled'],
  discoveryServiceName: ['discoveryServiceName'],
  discoveryServiceType: ['discoveryServiceType'],
  discoverySubtypes: ['discoverySubtypes'],
  discoveryInterfacesInclude: ['discoveryInterfacesInclude'],
  discoveryInterfacesExclude: ['discoveryInterfacesExclude'],
  discoveryAuthRequired: ['discoveryAuthRequired'],
  discoveryAdvertiseManagement: ['discoveryAdvertiseManagement'],
  host: ['host'],
  port: ['port'],
  authDir: ['authDir'],
  apiKeys: ['apiKeysText'],
  tlsEnable: ['tlsEnable'],
  tlsCert: ['tlsCert'],
  tlsKey: ['tlsKey'],
  rmAllowRemote: ['rmAllowRemote'],
  rmDisableControlPanel: ['rmDisableControlPanel'],
  rmDisableAutoUpdatePanel: ['rmDisableAutoUpdatePanel'],
  rmSecretKey: ['rmSecretKey'],
  rmPanelRepo: ['rmPanelRepo'],
  // ── routing and requests ──────────────────────────────────────────────────
  proxyUrl: ['proxyUrl'],
  requestRetry: ['requestRetry'],
  maxRetryCredentials: ['maxRetryCredentials'],
  maxRetryInterval: ['maxRetryInterval'],
  authAutoRefreshWorkers: ['authAutoRefreshWorkers'],
  routingStrategy: ['routingStrategy'],
  disableImageGeneration: ['disableImageGeneration'],
  gptImage2BaseModel: ['gptImage2BaseModel'],
  routingSessionAffinityTTL: ['routingSessionAffinityTTL'],
  forceModelPrefix: ['forceModelPrefix'],
  passthroughHeaders: ['passthroughHeaders'],
  disableCooling: ['disableCooling'],
  routingSessionAffinity: ['routingSessionAffinity'],
  wsAuth: ['wsAuth'],
  // ── logging ───────────────────────────────────────────────────────────────
  debug: ['debug'],
  commercialMode: ['commercialMode'],
  loggingToFile: ['loggingToFile'],
  logsMaxTotalSizeMb: ['logsMaxTotalSizeMb'],
  errorLogsMaxFiles: ['errorLogsMaxFiles'],
  redisUsageQueueRetentionSeconds: ['redisUsageQueueRetentionSeconds'],
  usageStatisticsEnabled: ['usageStatisticsEnabled'],
  // ── streaming ─────────────────────────────────────────────────────────────
  streamingKeepaliveSeconds: ['streaming.keepaliveSeconds'],
  streamingBootstrapRetries: ['streaming.bootstrapRetries'],
  streamingNonstreamKeepalive: ['streaming.nonstreamKeepaliveInterval'],
  // ── providers and plugins ─────────────────────────────────────────────────
  quotaAntigravityCredits: ['quotaAntigravityCredits'],
  pluginsEnabled: ['pluginsEnabled'],
  pluginStoreSources: ['pluginStoreSources'],
  pluginStoreAuth: ['pluginStoreAuth'],
  antigravitySensitiveWords: ['antigravitySensitiveWords'],
  devinSensitiveWords: ['devinSensitiveWords'],
  antigravitySignatureCacheEnabled: ['antigravitySignatureCacheEnabled'],
  antigravitySignatureBypassStrict: ['antigravitySignatureBypassStrict'],
  claudeHeaderUserAgent: ['claudeHeaderUserAgent'],
  claudeHeaderPackageVersion: ['claudeHeaderPackageVersion'],
  claudeHeaderRuntimeVersion: ['claudeHeaderRuntimeVersion'],
  claudeHeaderOs: ['claudeHeaderOs'],
  claudeHeaderArch: ['claudeHeaderArch'],
  claudeHeaderTimeout: ['claudeHeaderTimeout'],
  claudeHeaderStabilizeDeviceProfile: ['claudeHeaderStabilizeDeviceProfile'],
  codexHeaderUserAgent: ['codexHeaderUserAgent'],
  codexHeaderBetaFeatures: ['codexHeaderBetaFeatures'],
  // ── payload ───────────────────────────────────────────────────────────────
  payloadDefaultRules: ['payloadDefaultRules'],
  payloadDefaultRawRules: ['payloadDefaultRawRules'],
  payloadOverrideRules: ['payloadOverrideRules'],
  payloadOverrideRawRules: ['payloadOverrideRawRules'],
  payloadFilterRules: ['payloadFilterRules'],
  // ── quota history ─────────────────────────────────────────────────────────
  traceArchiveEnabled: ['traceArchiveEnabled'],
  traceArchiveDir: ['traceArchiveDir'],
  requestLog: ['requestLog'],
  quotaHistoryEnabled: ['quotaHistoryEnabled'],
  quotaHistoryInterval: ['quotaHistoryInterval'],
  quotaHistoryRetention: ['quotaHistoryRetention'],
  quotaHistoryPath: ['quotaHistoryPath'],
};

/** DOM id of a settings section; the navigation scrolls to it. */
export const configSectionDomId = (id: ConfigSectionId) => `config-section-${id}`;

/** localStorage key for the editor mode ('visual' | 'source'). */
export const CONFIG_MODE_STORAGE_KEY = 'config-management:tab';
/** Keys from retired layouts (simple/full mode, active tab); removed on mount. */
export const LEGACY_STORAGE_KEYS = ['config-management:editor-mode', 'config-management:section'];
