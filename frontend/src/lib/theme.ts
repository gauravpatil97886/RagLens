import { useCallback, useEffect, useState } from 'react';

/**
 * Theme.
 *
 * Three states, not two: `light`, `dark`, and `system` — because a laptop that
 * flips at sunset should take the instrument with it unless the reader has said
 * otherwise. Only an explicit choice is persisted; `system` stores nothing and
 * keeps following the OS for as long as the tab is open.
 *
 * The attribute lands on <html> before first paint (see the inline script in
 * index.html), so there is no light flash on a dark-mode load.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export type Resolved = 'light' | 'dark';

const KEY = 'rag-demo-theme';

const query = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

export function systemTheme(): Resolved {
  return query()?.matches ? 'dark' : 'light';
}

export function storedChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === 'light' || raw === 'dark' ? raw : 'system';
  } catch {
    return 'system';
  }
}

export function resolve(choice: ThemeChoice): Resolved {
  return choice === 'system' ? systemTheme() : choice;
}

/** Paint the choice. Surfaces cross-fade; text does not, so it never smears. */
function apply(resolved: Resolved, animate: boolean) {
  const root = document.documentElement;
  if (animate) {
    root.classList.add('theme-shifting');
    window.setTimeout(() => root.classList.remove('theme-shifting'), 260);
  }
  root.setAttribute('data-theme', resolved);
}

export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(storedChoice);
  const [resolved, setResolved] = useState<Resolved>(() => resolve(storedChoice()));

  // Following the OS only means anything while the choice is `system`.
  useEffect(() => {
    if (choice !== 'system') return;
    const mq = query();
    if (!mq) return;
    const onChange = () => {
      const next = systemTheme();
      setResolved(next);
      apply(next, true);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [choice]);

  const choose = useCallback((next: ThemeChoice) => {
    setChoice(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // A blocked localStorage costs persistence, never the theme itself.
    }
    const r = resolve(next);
    setResolved(r);
    apply(r, true);
  }, []);

  /** What the one-tap control does: go to the opposite of what is on screen. */
  const toggle = useCallback(() => {
    choose(resolved === 'dark' ? 'light' : 'dark');
  }, [choose, resolved]);

  return { choice, resolved, choose, toggle };
}
