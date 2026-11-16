import {
  HISTORY_ONLY_PROVIDERS,
  QUOTA_SORT_MODES,
  QUOTA_TAB_ORDER,
  QUOTA_VIEWS,
  type QuotaSortMode,
  type QuotaTabId,
  type QuotaView,
} from './constants';

/** Overview page UI preferences, kept for the session (sessionStorage) and not across sessions. */
export type QuotaUiState = {
  tab?: QuotaTabId;
  sortMode?: QuotaSortMode;
  view?: QuotaView;
  /** Resets calendar window filter: `all` or a period class (`week:1`). */
  resetsFilter?: string;
};

const QUOTA_UI_STATE_KEY = 'quotaPage.uiState';

const QUOTA_TAB_ID_SET = new Set<string>(['all', ...QUOTA_TAB_ORDER, ...HISTORY_ONLY_PROVIDERS]);
const QUOTA_SORT_MODE_SET = new Set<string>(QUOTA_SORT_MODES);

export const isQuotaTabId = (value: unknown): value is QuotaTabId =>
  typeof value === 'string' && QUOTA_TAB_ID_SET.has(value);

export const isQuotaSortMode = (value: unknown): value is QuotaSortMode =>
  typeof value === 'string' && QUOTA_SORT_MODE_SET.has(value);

export const readQuotaUiState = (): QuotaUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(QUOTA_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QuotaUiState;
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      tab: isQuotaTabId(parsed.tab) ? parsed.tab : undefined,
      sortMode: isQuotaSortMode(parsed.sortMode) ? parsed.sortMode : undefined,
      ...((QUOTA_VIEWS as readonly unknown[]).includes(parsed.view)
        ? { view: parsed.view as QuotaView }
        : {}),
      ...(typeof parsed.resetsFilter === 'string' && parsed.resetsFilter
        ? { resetsFilter: parsed.resetsFilter }
        : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Merge into whatever is already stored.
 *
 * Callers write one preference at a time — the tab strip knows nothing about
 * the sort control — so a whole-object write would silently drop the other
 * field every time either one changed.
 */
export const writeQuotaUiState = (state: QuotaUiState) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaUiState(), ...state };
    window.sessionStorage.setItem(QUOTA_UI_STATE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};

/** Emails are shown unless the viewer hid them; kept across sessions in this browser. */
const SHOW_EMAILS_KEY = 'quotaPage.showEmails';

export const readShowEmails = (): boolean => {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(SHOW_EMAILS_KEY);
    return raw === null ? true : raw !== 'false';
  } catch {
    return true;
  }
};

export const writeShowEmails = (show: boolean) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SHOW_EMAILS_KEY, show ? 'true' : 'false');
  } catch {
    // ignore
  }
};
