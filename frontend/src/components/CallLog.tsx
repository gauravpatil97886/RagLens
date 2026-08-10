import { useState } from 'react';
import type { ApiCallRecord } from '../types';
import { formatMs } from '../lib/format';
import { Figure, KIND_INK, KIND_LABEL, clockTime, integer } from './figures';

/**
 * The ledger, newest first. One row per thing that happened, including the
 * things that did not happen (cache) and the things that went wrong (429).
 *
 * Failures are the reason this panel exists. On the free tier the daily
 * generate quota runs out mid-session and the app simply stops answering; a
 * red row here with the quota named is the difference between "it broke" and
 * "you used your twenty calls".
 */

const PAGE = 12;

/** Turn a provider stack trace into one line a human can act on. */
function explain(error: string): { short: string; advice: string | null } {
  if (/RESOURCE_EXHAUSTED|\b429\b/.test(error)) {
    const quota = /limit: (\d+)/.exec(error);
    return {
      short: quota ? `429 quota exhausted — free-tier limit ${quota[1]}/day` : '429 quota exhausted',
      advice:
        'The free tier caps generate requests per day. Nothing is broken; the counter resets on Google’s clock. Cache hits keep working meanwhile.',
    };
  }
  if (/\b503\b|UNAVAILABLE/.test(error)) {
    return { short: '503 model unavailable', advice: 'Transient on Google’s side. Asking again usually works.' };
  }
  if (/timeout|deadline/i.test(error)) {
    return { short: 'timed out', advice: null };
  }
  return { short: error.split('\n')[0].slice(0, 90), advice: null };
}

function Row({ call }: { call: ApiCallRecord }) {
  const failed = !call.ok;
  const reason = failed && call.error ? explain(call.error) : null;

  return (
    <>
      <tr
        className={[
          'border-t border-line-soft align-baseline',
          failed ? 'bg-alert/[0.05]' : '',
        ].join(' ')}
      >
        <td className="whitespace-nowrap py-1.5 pl-3 pr-3 font-mono text-2xs tabular-nums text-paper-mute">
          {clockTime(call.created_at)}
        </td>

        <td className="whitespace-nowrap py-1.5 pr-3">
          <span className="inline-flex items-baseline gap-1.5 font-mono text-2xs uppercase tracking-micro text-paper-dim">
            <span
              className="translate-y-[-1px] inline-block h-1.5 w-1.5 rounded-[1px]"
              style={{ backgroundColor: KIND_INK[call.kind] }}
              aria-hidden="true"
            />
            {KIND_LABEL[call.kind]}
          </span>
        </td>

        <td className="max-w-[11rem] truncate py-1.5 pr-3 font-mono text-2xs text-paper-faint">
          {call.model}
        </td>

        <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
          {call.saved || call.tokens.total === 0 ? (
            <span className="text-paper-faint">—</span>
          ) : (
            <Figure
              value={integer(call.tokens.total)}
              estimated={call.tokens_estimated}
              why="Estimated: embedding responses carry no usage metadata."
            />
          )}
        </td>

        <td
          className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-faint"
          title={
            call.tokens.thinking > 0
              ? `${call.tokens.thinking} thinking tokens of ${call.tokens.total}`
              : undefined
          }
        >
          {call.tokens.thinking > 0 ? integer(call.tokens.thinking) : '—'}
        </td>

        <td className="whitespace-nowrap py-1.5 pr-3 text-right font-mono text-2xs tabular-nums text-paper-dim">
          {call.saved ? <span className="text-paper-faint">—</span> : formatMs(call.latency_ms)}
        </td>

        <td className="whitespace-nowrap py-1.5 pr-3 font-mono text-2xs uppercase tracking-micro">
          {failed ? (
            <span className="text-alert">failed</span>
          ) : call.saved ? (
            <span className="text-cache">cached</span>
          ) : (
            <span className="text-paper-mute">ok</span>
          )}
        </td>
      </tr>

      {reason && (
        <tr className="bg-alert/[0.05]">
          <td />
          <td colSpan={6} className="pb-2 pr-3 align-top">
            <p className="font-mono text-2xs text-alert" title={call.error ?? undefined}>
              {reason.short}
            </p>
            {reason.advice && (
              <p className="mt-0.5 max-w-prose text-[12.5px] leading-snug text-paper-mute">
                {reason.advice}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export default function CallLog({ recent }: { recent: ApiCallRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? recent : recent.slice(0, PAGE);

  if (recent.length === 0) {
    return (
      <p className="text-[13px] leading-relaxed text-paper-mute">
        The ledger is empty. Ask a question and every call it makes — or avoids — lands here.
      </p>
    );
  }

  return (
    <div>
      <div className="scroll-quiet -mx-4 overflow-x-auto px-4">
        <table className="w-full min-w-[38rem] border-collapse">
          <caption className="sr-only">
            The most recent API calls, newest first, with tokens, latency and outcome.
          </caption>
          <thead>
            <tr className="text-left font-mono text-2xs uppercase tracking-micro text-paper-faint">
              <th scope="col" className="pb-1.5 pl-3 pr-3 font-normal">
                time
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-normal">
                kind
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-normal">
                model
              </th>
              <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                tokens
              </th>
              <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                thinking
              </th>
              <th scope="col" className="pb-1.5 pr-3 text-right font-normal">
                latency
              </th>
              <th scope="col" className="pb-1.5 pr-3 font-normal">
                result
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((call) => (
              <Row key={call.id} call={call} />
            ))}
          </tbody>
        </table>
      </div>

      {recent.length > PAGE && (
        <button type="button" onClick={() => setExpanded((v) => !v)} className="btn mt-3">
          {expanded ? 'show fewer' : `show all ${recent.length}`}
        </button>
      )}
    </div>
  );
}
