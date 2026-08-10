/**
 * Both of this system's similarity bars, on one axis, because they are the
 * same unit: cosine similarity between two unit vectors.
 *
 * A learner meeting "0.25" and "0.87" in separate paragraphs has no way to
 * feel how far apart they are. Drawn on one 0→1 ruler, the answer is obvious:
 * the retrieval floor is barely a filter, and the cache bar is severe.
 */

const W = 460;
// Enough room for the centred "0.00" and "1.00" tick labels to sit inside the box.
const PAD = 22;
const AXIS_Y = 46;

export default function ThresholdScale({
  minSimilarity,
  cacheThreshold,
}: {
  minSimilarity: number;
  cacheThreshold: number;
}) {
  const x = (v: number) => PAD + v * (W - PAD * 2);
  // Keep a marker's label inside the box wherever the threshold happens to sit.
  const floorAnchor = minSimilarity > 0.6 ? 'end' : 'start';
  const floorDx = floorAnchor === 'end' ? -6 : 6;

  return (
    <figure className="mt-1">
      <div className="scroll-quiet overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} 84`}
          className="w-full min-w-[25rem]"
          role="img"
          aria-label={`Cosine similarity scale from 0 to 1. Chunks below ${minSimilarity} are discarded. A cached question at or above ${cacheThreshold} is reused instead of calling the model.`}
        >
          {/* Below the retrieval floor: not evidence. */}
          <rect x={x(0)} y={AXIS_Y - 7} width={x(minSimilarity) - x(0)} height={14} fill="#152329" />
          {/* At or above the cache bar: the model is never called. */}
          <rect
            x={x(cacheThreshold)}
            y={AXIS_Y - 7}
            width={x(1) - x(cacheThreshold)}
            height={14}
            fill="#55D6A8"
            opacity={0.18}
          />
          {/* Everything between: a real retrieval candidate. */}
          <rect
            x={x(minSimilarity)}
            y={AXIS_Y - 7}
            width={x(cacheThreshold) - x(minSimilarity)}
            height={14}
            fill="#F0A93B"
            opacity={0.12}
          />

          <line x1={x(0)} y1={AXIS_Y + 7} x2={x(1)} y2={AXIS_Y + 7} stroke="#1E3036" strokeWidth={1} />

          {[0, 0.25, 0.5, 0.75, 1].map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                y1={AXIS_Y + 7}
                x2={x(t)}
                y2={AXIS_Y + 12}
                stroke="#43575C"
                strokeWidth={1}
              />
              <text
                x={x(t)}
                y={AXIS_Y + 24}
                fontSize={10}
                textAnchor="middle"
                fill="#697E83"
                fontFamily="'JetBrains Mono', ui-monospace, monospace"
              >
                {t.toFixed(2)}
              </text>
            </g>
          ))}

          {/* Retrieval floor. */}
          <line
            x1={x(minSimilarity)}
            y1={AXIS_Y - 18}
            x2={x(minSimilarity)}
            y2={AXIS_Y + 7}
            stroke="#F0A93B"
            strokeWidth={2}
          />
          <text
            x={x(minSimilarity) + floorDx}
            y={AXIS_Y - 22}
            fontSize={10}
            textAnchor={floorAnchor}
            fill="#F0A93B"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
          >
            {minSimilarity} retrieval floor
          </text>

          {/* Semantic cache bar. */}
          <line
            x1={x(cacheThreshold)}
            y1={AXIS_Y - 18}
            x2={x(cacheThreshold)}
            y2={AXIS_Y + 7}
            stroke="#55D6A8"
            strokeWidth={2}
          />
          <text
            x={x(cacheThreshold) - 6}
            y={AXIS_Y - 22}
            fontSize={10}
            textAnchor="end"
            fill="#55D6A8"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
          >
            {cacheThreshold} cache bar
          </text>
        </svg>
      </div>

      <figcaption className="mt-1 max-w-[46rem] font-serif text-[14px] leading-[1.65] text-paper-dim">
        Two bars, one unit. A chunk only has to clear{' '}
        <span className="font-mono text-2xs text-signal">{minSimilarity}</span> to be worth
        showing the model, because the model can ignore a weak passage. A previous question has
        to clear <span className="font-mono text-2xs text-cache">{cacheThreshold}</span> before
        its answer is reused, because a wrong reuse is silent — you would never see the answer
        that should have been written.
      </figcaption>
    </figure>
  );
}
