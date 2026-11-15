/**
 * Theme state: light, dark, or follow the system ("auto", the default).
 *
 * The resolved theme is written to `<html data-theme>`. index.html applies the
 * stored choice before first paint using the same storage key, so keep the
 * persisted shape (`{ state: { theme } }`) in sync with it.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Theme } from '@/types';
import { STORAGE_KEY_THEME } from '@/utils/constants';

type ResolvedTheme = 'light' | 'dark';

interface ThemeState {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: Theme) => void;
  initializeTheme: () => () => void;
}

const getSystemTheme = (): ResolvedTheme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';

/** 'white' is a retired option kept for stored values; it now means light. */
const normalizeTheme = (theme: Theme): Theme => (theme === 'white' ? 'light' : theme);

const resolveTheme = (theme: Theme): ResolvedTheme => {
  const normalized = normalizeTheme(theme);
  return normalized === 'auto' ? getSystemTheme() : (normalized as ResolvedTheme);
};

const THEME_COLORS: Record<ResolvedTheme, string> = { light: '#fcfcfc', dark: '#000000' };

const applyTheme = (resolved: ResolvedTheme) => {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
  document
    .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
    .forEach((meta) => meta.setAttribute('content', THEME_COLORS[resolved]));
};

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      theme: 'auto',
      resolvedTheme: 'light',

      setTheme: (theme) => {
        const normalized = normalizeTheme(theme);
        const resolved = resolveTheme(normalized);
        applyTheme(resolved);
        set({ theme: normalized, resolvedTheme: resolved });
      },

      initializeTheme: () => {
        const { theme, setTheme } = get();
        setTheme(theme);

        if (typeof window === 'undefined' || !window.matchMedia) {
          return () => {};
        }

        // Follow system changes while in auto mode
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const listener = () => {
          if (get().theme !== 'auto') return;
          const resolved = getSystemTheme();
          applyTheme(resolved);
          set({ resolvedTheme: resolved });
        };

        mediaQuery.addEventListener('change', listener);
        return () => mediaQuery.removeEventListener('change', listener);
      },
    }),
    {
      name: STORAGE_KEY_THEME,
      partialize: (state) => ({ theme: state.theme }),
    }
  )
);
