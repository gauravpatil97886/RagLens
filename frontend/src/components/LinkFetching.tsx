import { useEffect, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { transition } from '../lib/motion';

/**
 * Waiting for a page, honestly.
 *
 * Preflight is a plain POST — one request, one response, no frames in between —
 * so this screen cannot know what the server is doing at any given moment. It
 * refuses to pretend otherwise. There is no progress bar, because there is no
 * progress to report; there are no ticks, because nothing here can say a stage
 * finished. What it does have is the *sequence*, which is genuinely known: the
 * server resolves the domain, fetches the page, then looks for the article in
 * it, in that order, every time.
 *
 * So the labels advance on a timer and the shimmer is indeterminate. The
 * current stage is lit, the ones before it are merely dimmer — never ticked.
 * The worst this can be is early: it might say "finding the article text" while
 * the fetch is still in flight, which is a claim about order, not completion.
 *
 * It usually takes under three seconds. The fetch timeout is fifteen, so past
 * six a line appears saying so, and the wait stops feeling like a hang.
 */

const STAGES = [
  { at: 0, label: 'Checking the domain' },
  { at: 450, label: 'Fetching the page' },
  { at: 1500, label: 'Finding the article text' },
] as const;

/** After this long a slow site needs explaining rather than just spinning. */
const PATIENCE_MS = 6000;

/** One grey bar of the skeleton. Widths vary so it reads as text, not as a form. */
function Bar({ className }: { className: string }) {
  return <span className={`block rounded bg-ink-700 ${className}`} />;
}

export default function LinkFetching({ domain }: { domain: string }) {
  const reduce = useReducedMotion() ?? false;
  const [elapsed, setElapsed] = useState(0);

  // One clock, read by both the stage labels and the patience line, so they
  // cannot disagree about how long this has been going on.
  useEffect(() => {
    const startedAt = Date.now();
    const timer = window.setInterval(() => setElapsed(Date.now() - startedAt), 150);
    return () => window.clearInterval(timer);
  }, []);

  const active = STAGES.reduce((found, stage, i) => (elapsed >= stage.at ? i : found), 0);
  const patient = elapsed >= PATIENCE_MS;

  return (
    <div className="space-y-4">
      {/* ── The skeleton of the card that is about to appear ──────────────── */}
      <div
        className="relative overflow-hidden rounded-2xl border border-line bg-ink-800"
        role="img"
        aria-label={`Fetching ${domain}`}
      >
        <div className="border-b border-line-soft px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 shrink-0 rounded-full bg-signal/30" />
            <span className="font-mono text-2xs text-paper-faint">{domain}</span>
          </div>
          <div className="mt-2.5 space-y-1.5">
            <Bar className="h-3.5 w-[70%]" />
            <Bar className="h-3.5 w-[42%]" />
          </div>
          <Bar className="mt-2.5 h-2 w-[30%]" />
        </div>

        <div className="space-y-2 px-4 py-3.5">
          <Bar className="h-2.5 w-full" />
          <Bar className="h-2.5 w-[94%]" />
          <Bar className="h-2.5 w-[88%]" />
          <Bar className="h-2.5 w-[52%]" />
        </div>

        {/* The scanning pass. A band of light crossing the card — the only thing
            on this screen that moves, and it makes no claim at all. */}
        {!reduce && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-sweep
                       bg-gradient-to-r from-transparent via-signal/[0.13] to-transparent"
          />
        )}
      </div>

      {/* ── The sequence, as far as it is known ───────────────────────────── */}
      <ul className="space-y-1.5">
        {STAGES.map((stage, i) => {
          const current = i === active;
          const reached = i <= active;
          return (
            <li
              key={stage.label}
              className={[
                'flex items-center gap-2.5 font-mono text-[12px]',
                current ? 'text-signal' : reached ? 'text-paper-mute' : 'text-paper-faint',
              ].join(' ')}
            >
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {current ? (
                  <span className="h-1.5 w-1.5 animate-breathe rounded-full bg-signal" />
                ) : (
                  <span
                    className={`h-1 w-1 rounded-full ${reached ? 'bg-paper-mute' : 'bg-paper-faint/60'}`}
                  />
                )}
              </span>
              <span className="flex-1 truncate">{stage.label}</span>
            </li>
          );
        })}
      </ul>

      <AnimatePresence initial={false}>
        {patient && (
          <motion.p
            key="patience"
            initial={{ opacity: 0, y: reduce ? 0 : 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={transition(reduce)}
            className="text-[12.5px] leading-relaxed text-paper-mute"
          >
            {domain} is taking its time. The fetch gives up after fifteen seconds, and nothing has
            been spent either way.
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
