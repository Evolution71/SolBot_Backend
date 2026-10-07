"""Small, safe schema upgrades applied at start-up.

`create_all` only creates missing tables. This module brings an existing database
forward by adding columns that newer code expects. It never drops user data, and
every step can be repeated, so an interrupted upgrade finishes on the next start.
"""
import logging

from sqlalchemy import inspect, text
from sqlalchemy.engine import Engine

from .database import Base

log = logging.getLogger("nexus.migrate")


def _literal(value, dialect: str) -> str:
    if isinstance(value, bool):
        return ("true" if value else "false") if dialect == "postgresql" else str(int(value))
    if isinstance(value, (int, float)):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def _scalar_default(column):
    return column.default.arg if column.default is not None and column.default.is_scalar else None


def _allow_many_wallets(engine: Engine) -> None:
    """Version 1 allowed one wallet per user (UNIQUE on wallets.user_id). Remove that rule."""
    insp = inspect(engine)
    tables = set(insp.get_table_names())
    dialect = engine.dialect.name
    table = Base.metadata.tables["wallets"]

    if dialect == "postgresql":
        if "wallets" not in tables:
            return
        for u in insp.get_unique_constraints("wallets"):
            if u["column_names"] == ["user_id"]:
                with engine.begin() as conn:
                    conn.execute(text(f'ALTER TABLE wallets DROP CONSTRAINT IF EXISTS "{u["name"]}"'))
                log.info("migration: users may now hold several wallets")
        return

    if dialect != "sqlite":
        return
    # SQLite cannot drop a constraint, so the table is rebuilt: rename, recreate, copy every row, drop the old one.
    if "wallets_v1" not in tables:
        if "wallets" not in tables or not any(
                u["column_names"] == ["user_id"] for u in insp.get_unique_constraints("wallets")):
            return
        index_names = [i["name"] for i in insp.get_indexes("wallets")]
        with engine.begin() as conn:
            for name in index_names:
                conn.execute(text(f'DROP INDEX IF EXISTS "{name}"'))
            conn.execute(text("ALTER TABLE wallets RENAME TO wallets_v1"))
    with engine.begin() as conn:
        table.create(conn, checkfirst=True)
        old_cols = {c["name"] for c in inspect(conn).get_columns("wallets_v1")}
        targets, sources = [], []
        for column in table.columns:
            if column.name in old_cols:
                targets.append(column.name)
                sources.append(column.name)
            elif _scalar_default(column) is not None:
                targets.append(column.name)
                sources.append(_literal(_scalar_default(column), dialect))
        if conn.execute(text("SELECT COUNT(*) FROM wallets")).scalar() == 0:
            conn.execute(text(f"INSERT INTO wallets ({', '.join(targets)}) SELECT {', '.join(sources)} FROM wallets_v1"))
        conn.execute(text("DROP TABLE wallets_v1"))
    log.info("migration: users may now hold several wallets")


def _add_missing_columns(engine: Engine) -> None:
    insp = inspect(engine)
    existing_tables = set(insp.get_table_names())
    dialect = engine.dialect.name
    for table in Base.metadata.sorted_tables:
        if table.name not in existing_tables:
            continue
        have = {c["name"] for c in insp.get_columns(table.name)}
        for column in table.columns:
            if column.name in have:
                continue
            default = _scalar_default(column)
            ddl = f"ALTER TABLE {table.name} ADD COLUMN {column.name} {column.type.compile(engine.dialect)}"
            if default is not None:
                ddl += f" DEFAULT {_literal(default, dialect)}"
            with engine.begin() as conn:
                conn.execute(text(ddl))
            log.info("migration: added %s.%s", table.name, column.name)


def upgrade(engine: Engine) -> None:
    _allow_many_wallets(engine)
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
