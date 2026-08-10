import { motion, useReducedMotion } from 'framer-motion';
import type { UserTurn } from '../types';
import { transition } from '../lib/motion';

/**
 * The question, as you asked it.
 *
 * A soft bubble offset to the right — the one shape in the thread that is
 * clearly *yours*. The answer opposite it is unbubbled and full width, because
 * a question is a sentence and an answer is a page.
 */
export default function UserBubble({ turn }: { turn: UserTurn }) {
  const reduce = useReducedMotion() ?? false;

  // The scope that was in force when this question ran — not whatever is
  // ticked right now. Changing the scope later must not rewrite history.
  const narrowed = turn.scopedTo !== null;
  const scope = narrowed
    ? `Asked across ${turn.scopedTo!.length} document${turn.scopedTo!.length === 1 ? '' : 's'}`
    : 'Asked across every document';

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition(reduce)}
      className="flex flex-col items-end gap-1.5 pl-12"
    >
      <div
        title={scope}
        className="max-w-[34rem] rounded-bubble rounded-br-md bg-ink-800 px-4 py-2.5
                   text-[15px] leading-[1.6] text-paper shadow-inset"
      >
        {turn.text}
      </div>
      {/* Only worth saying when it isn't the default. "Asked across every
          document" under every question is noise. */}
      {narrowed && <span className="pr-1 text-[11.5px] text-paper-faint">{scope}</span>}
    </motion.div>
  );
}
