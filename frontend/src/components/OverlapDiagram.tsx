import { integer } from './figures';

/**
 * Chunk overlap, drawn to scale from the live configuration.
 *
 * Three consecutive chunks at the real chunk_size, offset by the real stride.
 * The marigold bands are the characters that appear in two chunks at once —
 * they are exactly `chunk_overlap` wide because the drawing is proportional,
 * not illustrative. Change CHUNK_OVERLAP in the backend and this picture
 * changes with it.
 */

// Sized to sit at roughly 1:1 inside the pipeline column, so the mono labels
// in here render at the same size as the mono labels outside it.
const W = 460;
const PAD = 8;
const BAR_H = 16;
const ROW_GAP = 10;
const TOP = 22;

export default function OverlapDiagram({
  chunkSize,
  overlap,
}: {
  chunkSize: number;
  overlap: number;
}) {
  const stride = Math.max(1, chunkSize - overlap);
  const rows = 3;
  const span = stride * (rows - 1) + chunkSize;
  const s = (W - PAD * 2) / span;
  const x = (chars: number) => PAD + chars * s;

  const height = TOP + rows * (BAR_H + ROW_GAP) + 20;
  const bandTop = TOP - 6;
  const bandBottom = TOP + rows * (BAR_H + ROW_GAP) - ROW_GAP + 6;

  const starts = Array.from({ length: rows }, (_, i) => i * stride);
  const bands = starts.slice(1).map((start) => start);

  return (
    <figure className="mt-1">
      <div className="scroll-quiet overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${height}`}
          className="w-full min-w-[24rem]"
          role="img"
          aria-label={`Three consecutive chunks of ${chunkSize} characters, each starting ${stride} characters after the last, so consecutive chunks share ${overlap} characters.`}
        >
          {/* Shared regions, drawn first so the bars sit on top of them. */}
          {bands.map((start) => (
            <g key={`band-${start}`}>
              <rect
                x={x(start)}
                y={bandTop}
                width={overlap * s}
                height={bandBottom - bandTop}
                className="fill-signal"
                opacity={0.14}
              />
              <line
                x1={x(start)}
                y1={bandTop}
                x2={x(start)}
                y2={bandBottom}
                className="stroke-signal"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.6}
              />
              <line
                x1={x(start + overlap)}
                y1={bandTop}
                x2={x(start + overlap)}
                y2={bandBottom}
                className="stroke-signal"
                strokeWidth={1}
                strokeDasharray="2 3"
                opacity={0.6}
              />
            </g>
          ))}

          {starts.map((start, i) => {
            const y = TOP + i * (BAR_H + ROW_GAP);
            return (
              <g key={start}>
                <rect
                  x={x(start)}
                  y={y}
                  width={chunkSize * s}
                  height={BAR_H}
                  rx={4}
                  className="fill-signal-dim"
                />
                <text
                  x={x(start) + 8}
                  y={y + BAR_H / 2 + 3.5}
                  fontSize={10}
                  className="fill-ink-900"
                  fontFamily="'JetBrains Mono', ui-monospace, monospace"
                >
                  chunk {i} · {integer(start)}–{integer(start + chunkSize)}
                </text>
              </g>
            );
          })}

          {/* The measurement being made. */}
          <text
            x={x(starts[1]) + (overlap * s) / 2}
            y={height - 6}
            fontSize={10}
            textAnchor="middle"
            className="fill-signal"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
          >
            {overlap} shared
          </text>
          <text
            x={PAD}
            y={14}
            fontSize={10}
            className="fill-paper-mute"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
          >
            character 0
          </text>
          <text
            x={W - PAD}
            y={14}
            fontSize={10}
            textAnchor="end"
            className="fill-paper-mute"
            fontFamily="'JetBrains Mono', ui-monospace, monospace"
          >
            {integer(span)}
          </text>
        </svg>
      </div>

      <figcaption className="mt-1 max-w-[46rem] text-[14px] leading-[1.65] text-paper-dim">
        Each chunk starts <span className="font-mono text-2xs text-paper">{integer(stride)}</span>{' '}
        characters after the one before, not {integer(chunkSize)} — so every boundary is covered
        twice. Without that repeat, a sentence split across the seam would live in neither
        chunk’s embedding, and no amount of clever retrieval would find it.
      </figcaption>
    </figure>
  );
}
