/**
 * AI provider workbench view model (normalizes each brand's heterogeneous config)
 */

import type { ThinkingLevel } from './thinkingLevels';
import type { RuntimePolicyDraft } from './runtimePolicy';
import type { ModelOptionsInput } from './modelOptions';
import type { ProviderBehaviorOptions } from '@/types/provider';

export type ProviderBrand =
  | 'gemini'
  | 'interactions'
  | 'codex'
  | 'meta'
  | 'xai'
  | 'claude'
  | 'vertex'
  | 'openaiCompatibility';

export type ProviderResourceSelector =
  | { brand: 'gemini'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'interactions'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'codex'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'meta'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'xai'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'claude'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'vertex'; apiKey: string; baseUrl?: string; index: number }
  | { brand: 'openaiCompatibility'; name: string; index: number };

export interface ProviderResourceFlags {
  cloakEnabled?: boolean;
  claudeCodeCliProfile?: boolean;
  websockets?: boolean;
}

export interface ProviderResource {
  /** Stable id, used as the React key and for selection */
  id: string;
  brand: ProviderBrand;
  /** Index in the original array */
  originalIndex: number;
  /** Display name for the table key column (OpenAI = name, others = null) */
  name: string | null;
  /** Fallback display text (masked API key or fallback) */
  identifier: string;
  /** Masked apiKey preview for display */
  apiKeyPreview: string | null;
  /** Real apiKey used by the selector; null for OpenAI because it has multiple keys */
  apiKey: string | null;
  authIndex: string | null;
  baseUrl: string | null;
  proxyUrl: string | null;
  prefix: string | null;
  modelCount: number;
  /** Deduplicated model names, for filtering/search */
  models: string[];
  /** Priority used for sorting; 0 when not configured */
  priority: number;
  headerCount: number;
  excludedModelCount: number;
  /** Only meaningful for OpenAI; other brands keep it but do not show it */
  apiKeyEntryCount: number;
  /** Whether it is disabled (each brand has its own rule) */
  disabled: boolean;
  /** Extra capability flags */
  flags: ProviderResourceFlags;
  /** Selector used for delete/update */
  selector: ProviderResourceSelector;
  /** Original raw config, used to initialize the sheet form */
  raw: unknown;
}

export interface ProviderGroup {
  id: ProviderBrand;
  resources: ProviderResource[];
}

export interface ProviderSnapshot {
  fetchedAt: string;
  groups: ProviderGroup[];
}

/**
 * Shared sheet form values.
 * Gemini/Codex/Claude/Vertex/OpenAI share the base fields and each enables its own advanced section.
 */
export interface ModelEntryInput extends ModelOptionsInput {
  /** Only used by the OAuth alias editor. */
  fork?: boolean;
  sourceIndex?: number | null;
  name: string;
  alias?: string;
  priority?: number;
  image?: boolean;
  /** Original backend value, preserved until the standard-level selector is changed. */
  thinkingJson?: string;
  thinkingLevels?: ThinkingLevel[];
  thinkingLevelsTouched?: boolean;
}

export interface ApiKeyEntryInput {
  sourceIndex?: number;
  apiKey: string;
  existingApiKey?: string;
  proxyUrl: string;
  weight?: number;
  authIndex?: string;
}

export interface CloakInput {
  mode: string;
  strictMode: boolean;
  sensitiveWordsText: string;
  cacheUserId: boolean;
}

export interface ProviderEntryFormInput extends ProviderBehaviorOptions {
  /** OpenAI passes keys only in apiKeyEntries on create */
  apiKey: string;
  /** Required for OpenAI; not shown for other brands */
  name: string;
  baseUrl: string;
  proxyUrl: string;
  prefix: string;
  disabled: boolean;
  disableCooling?: boolean;
  runtimePolicy?: RuntimePolicyDraft;
  priority?: number;
  weight?: number;

  /** Advanced collapsible section */
  models: ModelEntryInput[];
  headers: Array<{ key: string; value: string }>;
  excludedModelsText: string;

  /** Codex only */
  websockets?: boolean;
  /** Claude only */
  cloak?: CloakInput;
  fingerprintProfile?: string;
  /** Temporary selection for connectivity tests only; never persisted in backend config. */
  testModel?: string;
  apiKeyEntries?: ApiKeyEntryInput[];
}
