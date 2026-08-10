"""Connection pool lifecycle and schema bootstrap.

Everything in this backend is synchronous: FastAPI runs plain `def` endpoints in a
threadpool, so a blocking psycopg pool is the simplest correct choice and we never mix
sync DB calls into the event loop.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from pathlib import Path

import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .config import REPO_ROOT, settings

log = logging.getLogger(__name__)

_pool: ConnectionPool | None = None

# The schema lives in sql/ at the repo root; in a container it is usually copied
# alongside the app. Try the obvious places rather than hard-coding one layout.
_SCHEMA_CANDIDATES = (
    REPO_ROOT / "sql" / "schema.sql",
    Path("/app/sql/schema.sql"),
    Path("sql/schema.sql"),
)


def _schema_sql() -> str | None:
    for path in _SCHEMA_CANDIDATES:
        if path.is_file():
            return path.read_text(encoding="utf-8")
    return None


def _configure(conn: psycopg.Connection) -> None:
    """Runs for every pooled connection. pgvector's type adapters are registered
    per-connection, so this cannot be done once globally."""
    register_vector(conn)


def init_db() -> None:
    """Create the extension + schema, then open the pool.

    Order matters: `register_vector` needs the `vector` type to already exist, so the
    extension is created on a plain bootstrap connection *before* the pool opens.
    """
    global _pool

    with psycopg.connect(settings.database_url, autocommit=True) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
        ddl = _schema_sql()
        if ddl:
            conn.execute(ddl)
        else:
            missing = conn.execute("SELECT to_regclass('public.chunks')").fetchone()[0] is None
            if missing:
                raise RuntimeError(
                    "sql/schema.sql not found and the schema is not present in the "
                    f"database. Looked in: {', '.join(str(p) for p in _SCHEMA_CANDIDATES)}"
                )
            log.warning("sql/schema.sql not found; assuming the schema was applied elsewhere")

    _pool = ConnectionPool(
        settings.database_url,
        min_size=1,
        max_size=10,
        configure=_configure,
        open=False,
    )
    _pool.open()
    _pool.wait(timeout=15)


def close_db() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def connection():
    """Checked-out connection with dict rows. Commits on clean exit, rolls back on error."""
    if _pool is None:
        raise RuntimeError("database pool is not initialised")
    with _pool.connection() as conn:
        conn.row_factory = dict_row
        yield conn


def scalar(sql: str, params: dict | None = None):
    with connection() as conn:
        row = conn.execute(sql, params or {}).fetchone()
    return None if row is None else next(iter(row.values()))


def healthy() -> bool:
    try:
        with connection() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:  # surfaced as db:false in /api/health, never fatal
        log.exception("database health check failed")
        return False
