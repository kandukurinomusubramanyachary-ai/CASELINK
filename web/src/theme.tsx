import React, { createContext, useContext, useEffect, useState } from 'react';
import { Icon } from './components/Icon';

export type ThemePreference = 'dark' | 'light' | 'system';
const KEY = 'caselink.theme';
const valid = (value: string | null): value is ThemePreference => value === 'dark' || value === 'light' || value === 'system';
const read = (): ThemePreference => { try { const value = localStorage.getItem(KEY); return valid(value) ? value : 'system'; } catch { return 'system'; } };
const systemTheme = () => window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
const ThemeContext = createContext<{ preference: ThemePreference; resolved: 'dark' | 'light'; setPreference: (value: ThemePreference) => void } | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setValue] = useState<ThemePreference>(read);
  const [system, setSystem] = useState<'light' | 'dark'>(systemTheme);
  const resolved = preference === 'system' ? system : preference;
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const changed = () => setSystem(media.matches ? 'light' : 'dark');
    media.addEventListener('change', changed);
    const storage = (event: StorageEvent) => { if (event.key === KEY || event.key === null) setValue(read()); };
    window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', changed); window.removeEventListener('storage', storage); };
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#101114' : '#e8ebe6');
  }, [resolved]);
  const setPreference = (value: ThemePreference) => {
    setValue(value);
    try { localStorage.setItem(KEY, value); } catch { /* An in-memory choice remains usable when storage is blocked. */ }
  };
  return <ThemeContext.Provider value={{ preference, resolved, setPreference }}>{children}</ThemeContext.Provider>;
}

export function useTheme() { const context = useContext(ThemeContext); if (!context) throw new Error('ThemeProvider is missing'); return context; }

export function ThemeControl({ compact = false }: { compact?: boolean }) {
  const { preference, resolved, setPreference } = useTheme();
  if (compact) return <label className="theme-picker" title={`Theme: ${preference} (${resolved})`}>
    <Icon name={preference === 'system' ? 'monitor' : resolved === 'dark' ? 'moon' : 'sun'} size={18} />
    <select aria-label="Theme preference" value={preference} onChange={event => setPreference(event.target.value as ThemePreference)}>
      <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
    </select>
  </label>;
  return <div className="theme-options" role="group" aria-label="Theme preference">
    {(['dark', 'light', 'system'] as const).map(value => <button key={value} type="button" aria-pressed={preference === value} onClick={() => setPreference(value)}><Icon name={value === 'dark' ? 'moon' : value === 'light' ? 'sun' : 'monitor'} size={16} />{value[0].toUpperCase() + value.slice(1)}</button>)}
  </div>;
}
