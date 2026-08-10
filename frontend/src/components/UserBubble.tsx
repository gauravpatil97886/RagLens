import { motion, useReducedMotion } from 'framer-motion';
import type { UserTurn } from '../types';
import { transition } from '../lib/motion';

export default function UserBubble({ turn }: { turn: UserTurn }) {
  const reduce = useReducedMotion() ?? false;

  // The scope that was in force when this question ran — not whatever is
  // ticked right now. Changing the scope later must not rewrite history.
  const scope =
    turn.scopedTo === null
      ? 'asked across the whole corpus'
      : `asked across ${turn.scopedTo.length} document${turn.scopedTo.length === 1 ? '' : 's'}`;

  return (
    <motion.div
      initial={{ opacity: 0, y: reduce ? 0 : 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition(reduce)}
      className="flex flex-col items-end gap-1.5 pl-10"
    >
      <div className="max-w-[42rem] rounded-2xl rounded-br-md border border-line-strong bg-ink-800 px-4 py-2.5 text-[15px] leading-relaxed text-paper">
        {turn.text}
      </div>
      <span className="font-mono text-2xs uppercase tracking-micro text-paper-faint">{scope}</span>
    </motion.div>
  );
}
