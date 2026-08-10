import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Copy-to-clipboard with a confirmation that lives on the button itself.
 *
 * The async Clipboard API needs a secure context, which a plain-http LAN
 * address is not — so there is a `execCommand` fallback, because "copy" going
 * quiet on someone's dev box is worse than a deprecated call.
 */
export function useCopy(resetMs = 1600) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const flash = useCallback(
    (next: 'copied' | 'failed') => {
      setState(next);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState('idle'), resetMs);
    },
    [resetMs],
  );

  const copy = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          flash('copied');
          return;
        }
        throw new Error('clipboard unavailable');
      } catch {
        // Insecure context or a denied permission — fall back to a selection.
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.top = '-1000px';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          document.body.removeChild(ta);
          flash(ok ? 'copied' : 'failed');
        } catch {
          flash('failed');
        }
      }
    },
    [flash],
  );

  return { copy, state };
}
