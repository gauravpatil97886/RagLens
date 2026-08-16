import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, RefreshCw } from 'lucide-react';
import { ApiError } from '../api';
import {
  ROWS_PER_PAGE,
  fixed,
  getInfraTable,
  isVectorCell,
  signedFixed,
  type CellValue,
  type InfraRowsPage,
  type VectorCell,
} from '../lib/infra';
import { integer } from './figures';

/**
 * Real rows out of a real table, fetched only when someone asks for them.
 *
 * The interesting cell type is the vector: 768 floats would be megabytes of
 * JSON per page, so the server sends a summary and the first eight values,
 * and the full thing lives one click away in the drawer.
 */

function VectorChip({
  cell,
  chunkId,
  onOpenVector,
}: {
  cell: VectorCell;
  chunkId: number | null;
  onOpenVector: (chunkId: number) => void;
}) {
  return (
    <div className="min-w-[19rem]">
      <div className="flex items-center gap-2">
        <span className="rounded border border-signal/30 bg-signal/[0.08] px-1.5 py-0.5 font-mono text-2xs tabular-nums text-signal">
          {cell.dims}d · {integer(cell.bytes)} B · ‖v‖={fixed(cell.l2_norm, 2)}
        </span>
        {chunkId !== null && (
          <button
            type="button"
            onClick={() => onOpenVector(chunkId)}
            className="btn px-1.5 py-1"
            title={`Open all ${cell.dims} values for chunk ${chunkId}`}
          >
            <Maximize2 size={10} />
            <span className="normal-case tracking-normal">open</span>
          </button>
        )}
      </div>
      <p className="mt-1 font-mono text-2xs tabular-nums text-paper-faint">
        [{cell.head.map((v) => signedFixed(v, 4)).join(', ')}
        {cell.head.length < cell.dims ? ', …' : ''}]
      </p>
    </div>
  );
}

function Cell({
  value,
  truncated,
  chunkId,
  onOpenVector,
}: {
  value: CellValue;
  truncated: boolean;
  chunkId: number | null;
  onOpenVector: (chunkId: number) => void;
}) {
  if (isVectorCell(value)) {
    return <VectorChip cell={value} chunkId={chunkId} onOpenVector={onOpenVector} />;
  }
  if (value === null || value === undefined) {
    return <span className="font-mono text-2xs text-paper-faint">null</span>;
  }
  if (typeof value === 'boolean') {
    return <span className="font-mono text-2xs text-paper-dim">{value ? 'true' : 'false'}</span>;
  }
  if (typeof value === 'number') {
    return <span className="font-mono text-[12.5px] tabular-nums text-paper-dim">{value}</span>;
  }
  return (
    <span
      className="block max-w-[26rem] truncate text-[12.5px] leading-snug text-paper-dim"
      title={value}
    >
      {value}
      {truncated && <span className="ml-1 font-mono text-2xs text-paper-faint">(clipped)</span>}
    </span>
  );
}

function RowSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-9 animate-breathe rounded bg-ink-800" />
      ))}
    </div>
  );
}

export default function InfraTableBrowser({
  table,
  onOpenVector,
}: {
  table: string;
  onOpenVector: (chunkId: number) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<InfraRowsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let live = true;
    setError(null);
    setLoading(true);

    getInfraTable(table, ROWS_PER_PAGE, offset, controller.signal)
      .then((next) => {
        if (!live) return;
        setPage(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!live || (err instanceof DOMException && err.name === 'AbortError')) return;
        setError(err instanceof ApiError ? err.message : `Could not read rows from ${table}.`);
        setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [table, offset, attempt]);

  if (error) {
    return (
      <div className="rounded-lg border border-alert/40 bg-alert/[0.06] px-3.5 py-3">
        <p className="font-mono text-2xs uppercase tracking-micro text-alert">rows unavailable</p>
        <p className="mt-1 text-[13px] leading-relaxed text-paper-dim">{error}</p>
        <button type="button" onClick={() => setAttempt((a) => a + 1)} className="btn mt-2.5">
          <RefreshCw size={11} />
          try again
        </button>
      </div>
    );
  }

  if (!page) return <RowSkeleton />;

  const from = page.total === 0 ? 0 : page.offset + 1;
  const to = Math.min(page.offset + page.limit, page.total);
  const canPrev = page.offset > 0;
  const canNext = to < page.total;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-2xs tabular-nums text-paper-mute">
          rows <span className="text-paper-dim">{integer(from)}</span>–
          <span className="text-paper-dim">{integer(to)}</span> of{' '}
          <span className="text-paper-dim">{integer(page.total)}</span>
        </p>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="btn px-2 py-1"
            disabled={!canPrev || loading}
            onClick={() => setOffset(Math.max(0, offset - ROWS_PER_PAGE))}
          >
            <ChevronLeft size={12} />
            <span className="normal-case tracking-normal">prev</span>
          </button>
          <button
            type="button"
            className="btn px-2 py-1"
            disabled={!canNext || loading}
            onClick={() => setOffset(offset + ROWS_PER_PAGE)}
          >
            <span className="normal-case tracking-normal">next</span>
            <ChevronRight size={12} />
          </button>
        </div>
      </div>

      {page.rows.length === 0 ? (
        <p className="mt-2.5 rounded-lg border border-dashed border-line-strong bg-ink-800 px-3.5 py-3 text-[13px] text-paper-mute">
          This table is empty. Nothing has written to it yet.
        </p>
      ) : (
        <div
          className={`scroll-quiet mt-2.5 overflow-x-auto rounded-lg border border-line bg-ink-900 transition-opacity duration-150 ${
            loading ? 'opacity-45' : ''
          }`}
          aria-busy={loading}
        >
          <table className="w-full min-w-max border-collapse text-left">
            <thead>
              <tr className="border-b border-line">
                {page.columns.map((c) => (
                  <th key={c.name} scope="col" className="px-3 py-2 align-bottom">
                    <span className="block font-mono text-2xs uppercase tracking-micro text-paper-dim">
                      {c.name}
                    </span>
                    <span className="mt-0.5 block font-mono text-2xs text-paper-faint">
                      {c.type}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {page.rows.map((row, i) => {
                const id = row['id'];
                const chunkId =
                  page.table === 'chunks' && typeof id === 'number' ? id : null;
                return (
                  <tr
                    key={typeof id === 'number' ? id : i}
                    className="border-b border-line-soft last:border-0 align-top transition-colors duration-150 hover:bg-ink-850"
                  >
                    {page.columns.map((c) => (
                      <td key={c.name} className="px-3 py-2">
                        <Cell
                          value={row[c.name] ?? null}
                          truncated={row[`${c.name}__truncated`] === true}
                          chunkId={chunkId}
                          onOpenVector={onOpenVector}
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
