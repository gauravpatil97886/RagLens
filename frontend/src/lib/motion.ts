import type { Transition, Variants } from 'framer-motion';

/**
 * Motion here has one job: make causality legible (retrieve, then generate).
 * Short durations, one easing curve, and everything collapses to a plain
 * opacity change when the visitor asks for reduced motion.
 */

export const EASE: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const DUR = {
  fast: 0.15,
  base: 0.22,
  slow: 0.3,
} as const;

export function transition(reduce: boolean, duration: number = DUR.base): Transition {
  return reduce ? { duration: 0.001 } : { duration, ease: EASE };
}

/** A spring with a little arrival weight — used for the cache badge only. */
export function reward(reduce: boolean): Transition {
  return reduce ? { duration: 0.001 } : { type: 'spring', stiffness: 520, damping: 26, mass: 0.7 };
}

/** Enter by rising slightly. The default for message and card entry. */
export function rise(reduce: boolean, distance = 8): Variants {
  return {
    hidden: { opacity: 0, y: reduce ? 0 : distance },
    show: { opacity: 1, y: 0 },
  };
}

/** Container that deals its children in sequence. */
export function stagger(reduce: boolean, step = 0.045): Variants {
  return {
    hidden: {},
    show: {
      transition: reduce ? { staggerChildren: 0 } : { staggerChildren: step, delayChildren: 0.02 },
    },
  };
}
