import { createContext, Fragment, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, type User } from '../core/api';
import { useAuth } from '../core/auth';
import { en, type Messages } from './en';
import { de } from './de';

// Lightweight, dependency-free i18n. Messages are plain typed objects — English
// is the source of truth (`Messages`), every other locale must match its shape,
// so a missing or misspelled key fails `tsc`. Strings with parameters are
// functions: `t.jobs.deleteConfirm(name)`.

export type Locale = 'en' | 'de';

export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
];

const MESSAGES: Record<Locale, Messages> = { en, de };

/** BCP 47 tags for `Intl` / `toLocaleString`. */
const INTL_TAGS: Record<Locale, string> = { en: 'en-US', de: 'de-DE' };

const STORAGE_KEY = 'amber.locale';

function isLocale(v: unknown): v is Locale {
  return v === 'en' || v === 'de';
}

function browserLocale(): Locale {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const l of langs) {
    const base = l?.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return 'en';
}

function storedLocale(): Locale | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return isLocale(v) ? v : null;
  } catch {
    return null;
  }
}

function rememberLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* storage unavailable — the server preference still applies after sign-in */
  }
}

// Module-level mirror of the active locale for non-React helpers (format.ts,
// cron.ts). The provider remounts its subtree on change, so helpers called
// during render always see the current value.
let current: Locale = storedLocale() ?? browserLocale();

/** Active locale, for non-React code. Components should use `useI18n()`. */
export function getLocale(): Locale {
  return current;
}

/** Messages of the active locale, for non-React code. Components use `useT()`. */
export function messages(): Messages {
  return MESSAGES[current];
}

/** `Intl` locale tag of the active locale, e.g. for `toLocaleString`. */
export function intlLocale(): string {
  return INTL_TAGS[current];
}

interface I18nContextValue {
  locale: Locale;
  /** The user's explicit choice; null follows the browser. */
  preference: Locale | null;
  t: Messages;
  setPreference: (locale: Locale | null) => Promise<void>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, refresh } = useAuth();
  // Before sign-in there is no server preference; use the last one this browser saw.
  const [guestLocale] = useState<Locale>(() => storedLocale() ?? browserLocale());
  const preference = user?.locale ?? null;
  const locale: Locale = user ? (preference ?? browserLocale()) : guestLocale;

  if (current !== locale) current = locale;
  if (document.documentElement.lang !== locale) document.documentElement.lang = locale;
  if (user) rememberLocale(locale);

  const setPreference = useCallback(
    async (next: Locale | null) => {
      await api.patch<User>('/auth/me/preferences', { locale: next });
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, preference, t: MESSAGES[locale], setPreference }),
    [locale, preference, setPreference],
  );

  return (
    <I18nContext.Provider value={value}>
      {/* Remount on change so helpers reading `messages()` re-render too. */}
      <Fragment key={locale}>{children}</Fragment>
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within an I18nProvider');
  return ctx;
}

/** Messages of the active locale. */
export function useT(): Messages {
  return useI18n().t;
}
