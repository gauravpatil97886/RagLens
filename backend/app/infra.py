"""Infra — look inside the database.

Four read-only questions a person learning RAG actually asks: how big is the vector
store, what does a stored vector look like, where does cached data live, and is the
index being used. Everything here reads the Postgres catalog or real rows; nothing is
estimated and nothing mutates.

Security posture, because this endpoint family is the one that touches raw tables:

* **No endpoint accepts SQL.** There is no query parameter, path segment or body field
  anywhere below that ends up as executable SQL.
* Table access goes through `TABLES`, a literal dict. A name is checked for membership
  in that dict *before* it is allowed near a query, and is then still passed through
  `psycopg.sql.Identifier` so even a whitelist mistake could not become an injection.
* `EXPLAIN` runs inside a transaction that is force-rolled-back and uses `SET LOCAL`,
  so the planner settings it flips cannot leak into the next user of that pooled
  connection.
* The database password never leaves this module: host/port/database are parsed out of
  `DATABASE_URL` and the credentials are dropped on the floor.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pgvector import Vector
from psycopg import sql

from . import db
from .config import settings

# The page-body cache lives in the links module, which is developed separately and may
# not be present in every checkout. Its absence is reported as an empty cache layer
# rather than a 500 — the other two layers are still worth showing.
try:
    from . import web
except ImportError:  # pragma: no cover - only hit in a partial checkout
    web = None  # type: ignore[assignment]

log = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# The whitelist. This dict is the only list of tables this module will ever read,
# and the plain-English role is what the UI shows beside each one.
# ---------------------------------------------------------------------------

TABLES: dict[str, str] = {
    "documents": (
        "One row per uploaded file or indexed link. This is the corpus as the reader "
        "sees it in the sidebar."
    ),
    "chunks": (
        "The text pieces and their vectors. This is what a question is searched against."
    ),
    "embedding_cache": (
        "One vector per unique piece of text, keyed by SHA-256. Stops the same text "
        "being embedded twice."
    ),
    "query_cache": (
        "Past questions, their vectors and their answers. Layer 1 matches the text "
        "exactly, layer 2 matches by meaning."
    ),
    "cache_stats": (
        "A single row of counters — exact hits, semantic hits, misses — behind the "
        "hit-rate figure."
    ),
    "api_calls": (
        "One row per Gemini request, and one per request a cache made unnecessary. "
        "Everything on the Signals view is read back out of here."
    ),
}

# Values wider than this are cut down before they go on the wire: the browser is for
# looking at rows, not for downloading a document.
_MAX_CELL_BYTES = 4096

# Enough rows to characterise the vectors, few enough that the overview stays fast even
# when the corpus is large. Norms are identical by construction (we L2-normalise before
# insert), so a sample tells the whole truth here.
_NORM_SAMPLE = 200

_HEAD_VALUES = 8
_PREVIEW_CHARS = 90
_NEIGHBOURS = 5


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def _iso(value: datetime | None) -> str | None:
    """Same timestamp shape as every other endpoint: ISO-8601, UTC, trailing Z."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _check_table(name: str) -> str:
    """Membership in the literal whitelist, checked before the name reaches any query.

    Returns the *whitelisted* string rather than the caller's, so what is composed into
    SQL later is a constant from this module, not user input that happened to compare
    equal.
    """
    for allowed in TABLES:
        if name == allowed:
            return allowed
    raise HTTPException(400, "Unknown table.")


def _pretty(conn, n_bytes: int) -> str:
    """pg_size_pretty for a number we computed in Python, so in-memory caches are
    formatted in exactly the same style as tables on disk."""
    row = conn.execute("SELECT pg_size_pretty(%(b)s::bigint) AS s", {"b": int(n_bytes)}).fetchone()
    return row["s"]


def _f(value: Any) -> float | None:
    return None if value is None else float(value)


def _collapse(text: str, limit: int = _PREVIEW_CHARS) -> str:
    """First ~n characters with whitespace collapsed — the preview shape used elsewhere."""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[:limit] + "…"


# ---------------------------------------------------------------------------
# Catalog SQL. All of it is static text with bound parameters; none of it is built
# from anything a caller sends.
# ---------------------------------------------------------------------------

_SERVER_SQL = """
-- server_version carries the packager's suffix ("17.10 (Debian ...)"); the reader wants
-- the version, so keep the first token only.
SELECT split_part(current_setting('server_version'), ' ', 1) AS postgres_version,
       current_database()                               AS database,
       pg_database_size(current_database())             AS database_bytes,
       pg_size_pretty(pg_database_size(current_database())) AS database_pretty,
       current_setting('max_connections')::int          AS max_connections,
       (SELECT count(*) FROM pg_stat_activity
         WHERE datname = current_database())            AS connections,
       (SELECT extversion FROM pg_extension
         WHERE extname = 'vector')                      AS pgvector_version
"""

# atttypmod carries pgvector's declared width, so this is the on-disk dimension rather
# than what config.py hopes it is.
_VECTOR_SQL = """
SELECT count(*)                                AS stored,
       COALESCE(sum(pg_column_size(embedding)), 0) AS vector_bytes,
       COALESCE(sum(pg_column_size(content)), 0)   AS text_bytes,
       COALESCE(max(pg_column_size(embedding)), 0) AS bytes_per_vector
  FROM chunks
"""

_DIM_SQL = """
SELECT a.atttypmod AS dim
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = %(table)s AND a.attname = %(column)s
"""

# Norms of a bounded sample. unnest() over the real[] cast is the only way to reach the
# individual components from SQL, and it is why this is sampled rather than exhaustive.
_NORM_SQL = f"""
SELECT min(n) AS min, avg(n) AS mean, max(n) AS max
  FROM (
    SELECT sqrt(sum(x::float8 * x::float8)) AS n
      FROM (SELECT id, embedding FROM chunks ORDER BY id LIMIT {_NORM_SAMPLE}) s,
           LATERAL unnest(s.embedding::real[]) AS x
     GROUP BY s.id
  ) t
"""

_SIZES_SQL = """
SELECT c.relname                                          AS name,
       pg_total_relation_size(c.oid)                      AS total_bytes,
       pg_size_pretty(pg_total_relation_size(c.oid))      AS total_pretty,
       pg_size_pretty(pg_relation_size(c.oid))            AS heap_pretty,
       pg_size_pretty(pg_indexes_size(c.oid))             AS index_pretty,
       pg_size_pretty(COALESCE(pg_total_relation_size(c.reltoastrelid), 0)) AS toast_pretty
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname = ANY(%(names)s)
"""

# typname = 'vector' is the honest test: query_cache.question_embedding and
# chunks.embedding are both vectors under different names, and a name-based guess would
# miss one of them the day someone adds a third.
_COLUMNS_SQL = """
SELECT c.relname                                  AS table_name,
       a.attname                                  AS name,
       format_type(a.atttypid, a.atttypmod)       AS type,
       NOT a.attnotnull                           AS nullable,
       (t.typname = 'vector')                     AS is_vector
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t      ON t.oid = a.atttypid
 WHERE n.nspname = 'public'
   AND c.relname = ANY(%(names)s)
   AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY c.relname, a.attnum
"""

_INDEXES_SQL = """
SELECT t.relname                             AS table_name,
       i.relname                             AS name,
       am.amname                             AS method,
       pg_relation_size(i.oid)               AS size_bytes,
       pg_size_pretty(pg_relation_size(i.oid)) AS size_pretty,
       (am.amname IN ('hnsw', 'ivfflat'))    AS is_vector,
       pg_get_indexdef(i.oid)                AS definition
  FROM pg_class t
  JOIN pg_index x     ON x.indrelid = t.oid
  JOIN pg_class i     ON i.oid = x.indexrelid
  JOIN pg_am am       ON am.oid = i.relam
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE n.nspname = 'public' AND t.relname = ANY(%(names)s)
 ORDER BY t.relname, i.relname
"""

_PK_SQL = """
SELECT a.attname AS name
  FROM pg_index x
  JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY(x.indkey)
 WHERE x.indrelid = %(oid)s::regclass AND x.indisprimary
 ORDER BY array_position(x.indkey, a.attnum)
"""

_OPCLASS = re.compile(r"vector_\w+_ops")


# ---------------------------------------------------------------------------
# GET /api/infra
# ---------------------------------------------------------------------------


def _server(conn) -> dict[str, Any]:
    row = conn.execute(_SERVER_SQL).fetchone()
    # Credentials are parsed off and discarded here; nothing downstream ever sees them.
    url = urlsplit(settings.database_url)
    return {
        "postgres_version": row["postgres_version"],
        "pgvector_version": row["pgvector_version"],
        "database": row["database"],
        "host": url.hostname,
        "port": url.port or 5432,
        "database_bytes": int(row["database_bytes"]),
        "database_pretty": row["database_pretty"],
        "connections": {"active": int(row["connections"]), "max": int(row["max_connections"])},
    }


def _vectors(conn) -> dict[str, Any]:
    stats = conn.execute(_VECTOR_SQL).fetchone()
    dim = conn.execute(_DIM_SQL, {"table": "chunks", "column": "embedding"}).fetchone()
    index = conn.execute(_INDEXES_SQL, {"names": ["chunks"]}).fetchall()
    vector_index = next((i for i in index if i["is_vector"]), None)

    stored = int(stats["stored"])
    vector_bytes = int(stats["vector_bytes"])
    text_bytes = int(stats["text_bytes"])

    norms = {"min": None, "mean": None, "max": None}
    if stored:
        row = conn.execute(_NORM_SQL).fetchone()
        norms = {
            "min": round(_f(row["min"]), 4) if row["min"] is not None else None,
            "mean": round(_f(row["mean"]), 4) if row["mean"] is not None else None,
            "max": round(_f(row["max"]), 4) if row["max"] is not None else None,
        }

    definition = (vector_index or {}).get("definition") or ""
    opclass = _OPCLASS.search(definition)
    return {
        "dimensions": int(dim["dim"]) if dim else None,
        "stored": stored,
        "bytes_per_vector": int(stats["bytes_per_vector"]),
        "vector_bytes": vector_bytes,
        "text_bytes": text_bytes,
        # Measured both sides: sum(pg_column_size(...)) is what is really on disk, so
        # this ratio survives compression and TOASTing instead of assuming dim * 4.
        "expansion_ratio": round(vector_bytes / text_bytes, 2) if text_bytes else None,
        "l2_norm": norms,
        "index_method": (vector_index or {}).get("method"),
        "index_ops": opclass.group(0) if opclass else None,
        "index_bytes": int(vector_index["size_bytes"]) if vector_index else None,
        "distance_operator": "<=>",
    }


def _tables(conn) -> list[dict[str, Any]]:
    names = list(TABLES)
    sizes = {r["name"]: r for r in conn.execute(_SIZES_SQL, {"names": names}).fetchall()}

    columns: dict[str, list[dict[str, Any]]] = {n: [] for n in names}
    for r in conn.execute(_COLUMNS_SQL, {"names": names}).fetchall():
        columns[r["table_name"]].append(
            {
                "name": r["name"],
                "type": r["type"],
                "nullable": bool(r["nullable"]),
                "is_vector": bool(r["is_vector"]),
            }
        )

    indexes: dict[str, list[dict[str, Any]]] = {n: [] for n in names}
    for r in conn.execute(_INDEXES_SQL, {"names": names}).fetchall():
        indexes[r["table_name"]].append(
            {
                "name": r["name"],
                "method": r["method"],
                "size_pretty": r["size_pretty"],
                "is_vector": bool(r["is_vector"]),
                "definition": r["definition"],
            }
        )

    out = []
    for name, role in TABLES.items():
        size = sizes.get(name)
        if size is None:  # a table the schema has not created yet
            continue
        out.append(
            {
                "name": name,
                "role": role,
                "rows": _count(conn, name),
                "total_bytes": int(size["total_bytes"]),
                "total_pretty": size["total_pretty"],
                "heap_pretty": size["heap_pretty"],
                "index_pretty": size["index_pretty"],
                "toast_pretty": size["toast_pretty"],
                "columns": columns[name],
                "indexes": indexes[name],
            }
        )
    return out


def _count(conn, table: str) -> int:
    """Exact count(*) for a whitelisted table.

    Exact rather than reltuples: these tables are small and a demo that shows an
    estimate where the reader expects a row count is a demo that lies.
    """
    table = _check_table(table)
    query = sql.SQL("SELECT count(*) AS n FROM {}").format(sql.Identifier("public", table))
    return int(conn.execute(query).fetchone()["n"])


def _page_cache() -> tuple[int, int]:
    """(entries, bytes) held by the in-process page-body cache.

    Reaching into web's private dict is deliberate: it is one process, this is a
    read-only inspector, and the alternative is asking another module to grow an API
    for a debug view. Entries are de-duplicated by normalised URL because each fetch is
    filed under both the requested and the final URL.
    """
    raw = getattr(web, "_cache", None) if web is not None else None
    if not raw:
        return 0, 0
    lock = getattr(web, "_cache_lock", None)
    snapshot = list(raw.values()) if lock is None else _locked_values(lock, raw)
    unique = {result.normalized_url: result for _stored_at, result in snapshot}
    return len(unique), sum(len(r.body) for r in unique.values())


def _locked_values(lock, raw) -> list[Any]:
    with lock:
        return list(raw.values())


def _caches(conn) -> list[dict[str, Any]]:
    embed_rows = _count(conn, "embedding_cache")
    query_rows = _count(conn, "query_cache")
    names = ["embedding_cache", "query_cache"]
    rows = conn.execute(_SIZES_SQL, {"names": names}).fetchall()
    sizes = {r["name"]: r["total_pretty"] for r in rows}
    page_rows, page_bytes = _page_cache()

    return [
        {
            "layer": "embedding_cache",
            "where": "postgres",
            "what": (
                "One vector per unique chunk of text, keyed by SHA-256. Stops the same "
                "text being embedded twice."
            ),
            "rows": embed_rows,
            "size_pretty": sizes.get("embedding_cache", "0 bytes"),
            "key": "content_sha256 + task_type + dim",
            "ttl": None,
        },
        {
            "layer": "query_cache",
            "where": "postgres",
            "what": (
                "Past questions, their vectors and their answers. Layer 1 matches the "
                "text exactly, layer 2 matches by meaning."
            ),
            "rows": query_rows,
            "size_pretty": sizes.get("query_cache", "0 bytes"),
            "key": "question_norm + scope_key",
            "ttl": f"{settings.cache_ttl_hours}h",
        },
        {
            "layer": "page_fetch_cache",
            "where": "memory",
            "what": (
                "Fetched page bytes, so pressing Index does not download the page a "
                "second time."
            ),
            "rows": page_rows,
            "size_pretty": _pretty(conn, page_bytes) if page_rows else "0 bytes",
            "key": "normalised URL",
            "ttl": f"{settings.fetch_cache_ttl_seconds}s",
        },
    ]


def overview() -> dict[str, Any]:
    """Everything the Infra dashboard needs in one round trip."""
    with db.connection() as conn:
        counters = conn.execute(
            "SELECT exact_hits, semantic_hits, misses FROM cache_stats WHERE id = true"
        ).fetchone() or {"exact_hits": 0, "semantic_hits": 0, "misses": 0}

        return {
            "server": _server(conn),
            "vectors": _vectors(conn),
            "tables": _tables(conn),
            "caches": _caches(conn),
            "counters": {
                "exact_hits": int(counters["exact_hits"]),
                "semantic_hits": int(counters["semantic_hits"]),
                "misses": int(counters["misses"]),
            },
        }


@router.get("/api/infra")
def api_infra():
    return overview()


# ---------------------------------------------------------------------------
# GET /api/infra/table/{name}
# ---------------------------------------------------------------------------


def _cell(value: Any) -> tuple[Any, bool]:
    """One non-vector value, ready for JSON. Returns (value, truncated)."""
    if isinstance(value, (bytes, bytearray, memoryview)):
        raw = bytes(value)
        head = raw[: _MAX_CELL_BYTES // 2].hex()
        return (head + "…", True) if len(raw) > _MAX_CELL_BYTES // 2 else (raw.hex(), False)
    if isinstance(value, (datetime,)):
        return _iso(value), False
    if isinstance(value, date):
        return value.isoformat(), False
    if isinstance(value, Decimal):
        return float(value), False
    if isinstance(value, str) and len(value) > _MAX_CELL_BYTES:
        return value[:_MAX_CELL_BYTES] + "…", True
    if isinstance(value, (list, dict)):
        # json/jsonb. Truncating it makes it a string rather than a structure, which is
        # why the sibling __truncated flag matters: the UI must not try to parse it.
        rendered = json.dumps(value, ensure_ascii=False, default=str)
        if len(rendered) > _MAX_CELL_BYTES:
            return rendered[:_MAX_CELL_BYTES] + "…", True
    return value, False


def _vector_cell(row: dict[str, Any], column: str) -> dict[str, Any] | None:
    """The collapsed form of a vector column.

    768 floats per row per vector column would be megabytes of JSON for one page of
    results, so the browser never returns a whole vector — head plus the numbers that
    describe the rest. GET /api/infra/vector/{id} is where you go for all of it.
    """
    if row[f"{column}__dims"] is None:
        return None
    head = row[f"{column}__head"] or []
    norm = row[f"{column}__norm"]
    return {
        "__vector__": True,
        "dims": int(row[f"{column}__dims"]),
        "bytes": int(row[f"{column}__bytes"]),
        "l2_norm": round(float(norm), 4) if norm is not None else None,
        "head": [round(float(v), 6) for v in head],
    }


def table_rows(name: str, limit: int = 25, offset: int = 0) -> dict[str, Any]:
    """A page of real rows from one whitelisted table.

    `name` is validated against the literal whitelist before anything is composed, and
    the validated constant is then still wrapped in `sql.Identifier` — the quoting is
    the second line of defence, not the first.
    """
    table = _check_table(name)
    limit = max(1, min(int(limit), 100))
    offset = max(0, int(offset))

    with db.connection() as conn:
        columns = [
            {"name": r["name"], "type": r["type"], "is_vector": bool(r["is_vector"])}
            for r in conn.execute(_COLUMNS_SQL, {"names": [table]}).fetchall()
        ]
        if not columns:
            raise HTTPException(400, "Unknown table.")

        total = _count(conn, table)
        relation = sql.Identifier("public", table)

        selects: list[sql.Composable] = []
        for col in columns:
            ident = sql.Identifier(col["name"])
            if col["is_vector"]:
                selects.extend(
                    [
                        sql.SQL("vector_dims(t.{c}) AS {a}").format(
                            c=ident, a=sql.Identifier(f"{col['name']}__dims")
                        ),
                        sql.SQL("pg_column_size(t.{c}) AS {a}").format(
                            c=ident, a=sql.Identifier(f"{col['name']}__bytes")
                        ),
                        sql.SQL(
                            "(SELECT sqrt(sum(x::float8 * x::float8)) "
                            "FROM unnest(t.{c}::real[]) AS x) AS {a}"
                        ).format(c=ident, a=sql.Identifier(f"{col['name']}__norm")),
                        sql.SQL("(t.{c}::real[])[1:{n}] AS {a}").format(
                            c=ident,
                            n=sql.Literal(_HEAD_VALUES),
                            a=sql.Identifier(f"{col['name']}__head"),
                        ),
                    ]
                )
            else:
                selects.append(sql.SQL("t.{c} AS {a}").format(c=ident, a=ident))

        # Stable paging needs a deterministic order; the primary key is the honest one,
        # and ctid is the fallback for a table that somehow has none.
        pk = [r["name"] for r in conn.execute(_PK_SQL, {"oid": f"public.{table}"}).fetchall()]
        order = (
            sql.SQL(", ").join(sql.SQL("t.{}").format(sql.Identifier(c)) for c in pk)
            if pk
            else sql.SQL("t.ctid")
        )

        query = sql.SQL(
            "SELECT {cols} FROM {rel} AS t ORDER BY {order} LIMIT %(limit)s OFFSET %(offset)s"
        ).format(cols=sql.SQL(", ").join(selects), rel=relation, order=order)
        raw = conn.execute(query, {"limit": limit, "offset": offset}).fetchall()

    rows = []
    for r in raw:
        out: dict[str, Any] = {}
        for col in columns:
            if col["is_vector"]:
                out[col["name"]] = _vector_cell(r, col["name"])
            else:
                value, truncated = _cell(r[col["name"]])
                out[col["name"]] = value
                if truncated:
                    out[f"{col['name']}__truncated"] = True
        rows.append(out)

    return {
        "table": table,
        "total": total,
        "limit": limit,
        "offset": offset,
        "columns": [{"name": c["name"], "type": c["type"]} for c in columns],
        "rows": rows,
    }


@router.get("/api/infra/table/{name}")
def api_infra_table(name: str, limit: int = 25, offset: int = 0):
    return table_rows(name, limit, offset)


# ---------------------------------------------------------------------------
# GET /api/infra/vector/{chunk_id}
# ---------------------------------------------------------------------------

_CHUNK_SQL = """
SELECT c.id, c.document_id, c.chunk_index, c.content,
       d.filename,
       vector_dims(c.embedding)  AS dims,
       pg_column_size(c.embedding) AS bytes,
       c.embedding::real[]       AS values
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
 WHERE c.id = %(id)s
"""

# The same <=> query retrieval runs, aimed at a stored vector instead of a question.
_NEIGHBOURS_SQL = """
SELECT c.id AS chunk_id, d.filename, c.chunk_index, c.content,
       1 - (c.embedding <=> %(q)s) AS similarity
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
 WHERE c.id <> %(id)s
 ORDER BY c.embedding <=> %(q)s
 LIMIT %(k)s
"""


def vector(chunk_id: int) -> dict[str, Any]:
    """One whole vector, its distribution, and the five chunks nearest to it."""
    with db.connection() as conn:
        row = conn.execute(_CHUNK_SQL, {"id": chunk_id}).fetchone()
        if row is None:
            raise HTTPException(404, f"No chunk with id {chunk_id}.")

        values = [float(v) for v in row["values"]]
        probe = Vector(values)
        neighbours = conn.execute(
            _NEIGHBOURS_SQL, {"q": probe, "id": chunk_id, "k": _NEIGHBOURS}
        ).fetchall()

    n = len(values)
    total = sum(values)
    norm = sum(v * v for v in values) ** 0.5
    return {
        "chunk_id": int(row["id"]),
        "document_id": int(row["document_id"]),
        "filename": row["filename"],
        "chunk_index": int(row["chunk_index"]),
        "content": row["content"],
        "dims": int(row["dims"]),
        "bytes": int(row["bytes"]),
        "l2_norm": round(norm, 4),
        "stats": {
            "min": round(min(values), 4) if n else None,
            "max": round(max(values), 4) if n else None,
            "mean": round(total / n, 4) if n else None,
            "abs_mean": round(sum(abs(v) for v in values) / n, 4) if n else None,
        },
        "values": values,
        "neighbours": [
            {
                "chunk_id": int(nb["chunk_id"]),
                "filename": nb["filename"],
                "chunk_index": int(nb["chunk_index"]),
                "similarity": round(float(nb["similarity"]), 4),
                "preview": _collapse(nb["content"]),
            }
            for nb in neighbours
        ],
    }


@router.get("/api/infra/vector/{chunk_id}")
def api_infra_vector(chunk_id: int):
    return vector(chunk_id)


# ---------------------------------------------------------------------------
# GET /api/infra/explain
# ---------------------------------------------------------------------------

# Deliberately the same shape as rag.retrieve()'s unscoped query — explaining a
# different query would tell the reader about a query nothing runs.
_RETRIEVAL_SQL = """
SELECT c.id AS chunk_id, c.document_id, d.filename, c.chunk_index, c.content,
       1 - (c.embedding <=> %(q)s) AS similarity
  FROM chunks c
  JOIN documents d ON d.id = c.document_id
 WHERE d.status = 'ready'
 ORDER BY c.embedding <=> %(q)s
 LIMIT %(k)s
"""

_GENERATE_LATENCY_SQL = """
SELECT avg(latency_ms) AS avg_ms, count(*) AS n
  FROM api_calls
 WHERE kind = 'generate' AND NOT saved AND ok
"""


def _walk(node: dict[str, Any]):
    yield node
    for child in node.get("Plans", []) or []:
        yield from _walk(child)


def _summarise(plan: list[dict[str, Any]], vector_indexes: set[str]) -> dict[str, Any]:
    """Turn one EXPLAIN JSON document into {plan, uses_index, ms}.

    We report the node that touches `chunks`, not the root: the root is always a Limit,
    and "Limit" tells the reader nothing about whether the index was used. `_vector` is
    internal — "an index" and "the *vector* index" are different claims, and only the
    verdict needs to tell them apart.
    """
    root = plan[0]["Plan"]
    nodes = list(_walk(root))
    scan = next((n for n in nodes if n.get("Relation Name") == "chunks"), root)

    index_name = scan.get("Index Name")
    node_type = scan.get("Node Type", "unknown")
    if index_name:
        label = f"{node_type} using {index_name}"
    elif scan.get("Relation Name"):
        label = f"{node_type} on {scan['Relation Name']}"
    else:
        label = node_type

    return {
        "plan": label,
        "uses_index": bool(index_name) and "Index" in node_type,
        "ms": round(float(plan[0]["Execution Time"]), 3),
        "_vector": index_name in vector_indexes,
    }


def _gap_phrase(a: dict[str, Any], b: dict[str, Any]) -> str:
    """How to describe the difference between two timings without overclaiming it."""
    gap = abs(a["ms"] - b["ms"])
    slower = max(a["ms"], b["ms"])
    if gap < 0.1 or (slower and gap / slower < 0.1):
        return "the two are within measurement noise of each other"
    return f"a {gap:.3f} ms difference"


def _verdict(rows: int, chosen: dict[str, Any], forced: dict[str, Any], knobs: str) -> str:
    """Plain English generated from the two measurements above it.

    Written from `rows`, the two measured plans and the settings that produced the
    second one, so it can never disagree with the numbers the UI prints beside it.
    """
    if chosen["_vector"]:
        return (
            f"Postgres is reaching for the vector index on its own ({chosen['plan']}), "
            f"finishing in {chosen['ms']} ms over {rows:,} rows against {forced['ms']} ms "
            "for the alternative plan. At this size the index is already paying for itself."
        )

    if not forced["_vector"]:
        # The interesting negative result: even pushed, the planner would rather read
        # everything than walk an HNSW graph, because at this size that is cheaper.
        return (
            f"Postgres is choosing {chosen['plan']} at {chosen['ms']} ms, and even with "
            f"{knobs} it still does not reach for the vector index — it picks "
            f"{forced['plan']} at {forced['ms']} ms instead. At {rows:,} rows, sorting "
            f"{rows:,} distances is simply cheaper than walking an HNSW graph. The index is "
            "there for the corpus this is going to become, not the one it is."
        )

    if chosen["ms"] <= forced["ms"]:
        return (
            f"Postgres is choosing {chosen['plan']}, and it is right: at {rows:,} rows the "
            f"scan takes {chosen['ms']} ms, while {forced['plan']} — which only appears once "
            f"{knobs} — takes {forced['ms']} ms. The index earns its place as the corpus grows."
        )

    return (
        f"Postgres is choosing {chosen['plan']} at {chosen['ms']} ms even though "
        f"{forced['plan']} — which only appears once {knobs} — measures {forced['ms']} ms. "
        f"That is {_gap_phrase(chosen, forced)} over {rows:,} rows: too small a margin to "
        "argue with the planner over. The index starts winning properly as the corpus grows."
    )


def _note(chosen: dict[str, Any], forced: dict[str, Any], generate_ms: float | None) -> str:
    """The 'so what' line: retrieval cost measured against the model call, when we have
    a measured model call to compare it to."""
    typical = max(chosen["ms"], forced["ms"])
    if generate_ms:
        ratio = generate_ms / typical if typical else 0
        return (
            f"Retrieval takes about {typical:.1f} ms either way. The model averages "
            f"{generate_ms:,.0f} ms on this machine — roughly {ratio:,.0f}x longer. "
            "Search is not the bottleneck here."
        )
    return (
        f"Retrieval takes about {typical:.1f} ms either way, with or without the index. "
        "Ask a question and compare that with the generation time on the Signals view: "
        "search is not where the time goes."
    )


def explain() -> dict[str, Any]:
    """EXPLAIN (ANALYZE, BUFFERS) the real retrieval query, twice.

    Once as the planner chooses, once with `SET LOCAL enable_seqscan = off` so the two
    strategies can be priced against each other. `SET LOCAL` plus a forced rollback
    means the pooled connection goes back to the pool with its planner settings and its
    (read-only) work untouched.
    """
    k = settings.top_k

    with db.connection() as conn:
        probe_row = conn.execute(
            "SELECT embedding::real[] AS values FROM chunks ORDER BY id LIMIT 1"
        ).fetchone()
        if probe_row is None:
            raise HTTPException(
                400, "There are no chunks yet, so there is no retrieval query to explain."
            )
        probe = Vector([float(v) for v in probe_row["values"]])
        rows_in_table = _count(conn, "chunks")
        latency = conn.execute(_GENERATE_LATENCY_SQL).fetchone()
        vector_indexes = {
            r["name"]
            for r in conn.execute(_INDEXES_SQL, {"names": ["chunks"]}).fetchall()
            if r["is_vector"]
        }

        explain_sql = "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + _RETRIEVAL_SQL
        params = {"q": probe, "k": k}

        with conn.transaction(force_rollback=True):
            chosen = _summarise(
                conn.execute(explain_sql, params).fetchone()["QUERY PLAN"], vector_indexes
            )
            # LOCAL: reverted by the rollback below, so the next borrower of this pooled
            # connection never inherits a crippled planner.
            conn.execute("SET LOCAL enable_seqscan = off")
            knobs = "enable_seqscan = off"
            forced = _summarise(
                conn.execute(explain_sql, params).fetchone()["QUERY PLAN"], vector_indexes
            )

            if vector_indexes and not forced["_vector"]:
                # Disabling seq scans alone is not always enough: with few rows the
                # planner will read the whole table through some *other* index and sort,
                # which prices the wrong thing. Take away the sort too, so the second
                # plan is really the vector-index plan this endpoint exists to price.
                conn.execute("SET LOCAL enable_sort = off")
                deeper = _summarise(
                    conn.execute(explain_sql, params).fetchone()["QUERY PLAN"], vector_indexes
                )
                if deeper["_vector"]:
                    forced = deeper
                    knobs = "enable_seqscan = off, enable_sort = off"

    generate_ms = _f(latency["avg_ms"]) if latency and latency["n"] else None
    verdict = _verdict(rows_in_table, chosen, forced, knobs)
    note = _note(chosen, forced, generate_ms)

    display = _RETRIEVAL_SQL.strip().replace("%(q)s", "$1").replace("%(k)s", str(k))
    return {
        "query": display,
        "rows_in_table": rows_in_table,
        # _vector was only ever for the verdict; the wire shape is the contract's.
        "chosen": {f: v for f, v in chosen.items() if not f.startswith("_")},
        "forced_index": {f: v for f, v in forced.items() if not f.startswith("_")},
        "verdict": verdict,
        "note": note,
    }


@router.get("/api/infra/explain")
def api_infra_explain():
    return explain()
