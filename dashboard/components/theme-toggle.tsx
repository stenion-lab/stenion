'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

const STORAGE_KEY = 'stenion-theme';

/**
 * Reads the current theme from the <html> data-theme attribute (set by the
 * no-flash inline script in layout.tsx). Falls back to 'dark' when no attribute
 * is present (the default dark-mode state).
 */
function readTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  const stored = document.documentElement.getAttribute('data-theme');
  return stored === 'light' ? 'light' : 'dark';
}

/**
 * Theme toggle that respects system preference on first visit and persists
 * explicit user choices in localStorage.
 *
 * 1. On first visit with no stored preference → follows prefers-color-scheme.
 * 2. On subsequent visits with a stored preference → uses that.
 * 3. User clicks toggle → switches mode, saves choice to localStorage.
 * 4. System preference changes while no explicit choice is saved → follows it.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark'>(readTheme);

  // Follow system preference changes when the user hasn't made an explicit choice.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e: MediaQueryListEvent) => {
      const choice = localStorage.getItem(STORAGE_KEY);
      if (choice === null) {
        setTheme(e.matches ? 'light' : 'dark');
      }
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Sync the data-theme attribute to the DOM on every state change.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggle = () => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* localStorage may be unavailable in private browsing / sandboxed iframes */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
      className="grid h-9 w-9 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
    </button>
  );
}