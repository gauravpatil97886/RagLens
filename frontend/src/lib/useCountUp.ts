import { useEffect, useRef, useState } from 'react';

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/**
 * Animates from the previous value to the next one whenever `value` changes.
 * Hand-rolled on rAF so the caller controls rounding — stats like "31%" and
 * "12 saved calls" should never flash a fractional intermediate.
 */
export function useCountUp(value: number, duration = 550, reduce = false): number {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;

    if (reduce || from === to || !Number.isFinite(to)) {
      fromRef.current = to;
      setDisplay(to);
      return;
    }

    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const next = from + (to - from) * easeOutCubic(t);
      setDisplay(next);
      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = to;
        frameRef.current = null;
      }
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      // Land on the target so an interrupted run never leaves a stale number.
      fromRef.current = to;
    };
  }, [value, duration, reduce]);

  return display;
}
