"""SQLite storage for Ledger.

`observations` is owned by FRED: every refresh upserts, so revisions win.
`loan` is owned by the user: it's only written from the panel's form, never
seeded or touched on startup.
"""
from __future__ import annotations

import os
import sqlite3
from datetime import datetime

from homeassistant.core import HomeAssistant

from .const import DB_NAME

SCHEMA_VERSION = 1

LOAN_FIELDS = ("balance", "rate", "payment", "as_of", "closing_costs", "target_months", "quote_spread")


def _connect(hass: HomeAssistant) -> sqlite3.Connection:
    conn = sqlite3.connect(os.path.join(hass.config.config_dir, DB_NAME))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(hass: HomeAssistant) -> None:
    with _connect(hass) as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS observations (
                series_id TEXT NOT NULL,
                obs_date  TEXT NOT NULL,   -- ISO date
                value     REAL NOT NULL,   -- percent
                PRIMARY KEY (series_id, obs_date)
            );
            CREATE TABLE IF NOT EXISTS loan (
                id            INTEGER PRIMARY KEY CHECK (id = 1),
                balance       REAL NOT NULL,     -- principal as of as_of
                rate          REAL NOT NULL,     -- percent
                payment       REAL NOT NULL,     -- monthly P&I, no escrow
                as_of         TEXT NOT NULL,     -- ISO date the balance was read
                closing_costs REAL NOT NULL,
                target_months INTEGER NOT NULL,  -- break-even you'd accept
                quote_spread  REAL NOT NULL DEFAULT 0,  -- your quote minus the survey
                updated_at    TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS meta (
                key   TEXT PRIMARY KEY,
                value TEXT
            );
            """
        )
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', ?)",
            (str(SCHEMA_VERSION),),
        )


def save_observations(hass: HomeAssistant, series_id: str, rows: list[tuple[str, float]]) -> int:
    with _connect(hass) as conn:
        conn.executemany(
            "INSERT INTO observations (series_id, obs_date, value) VALUES (?, ?, ?) "
            "ON CONFLICT(series_id, obs_date) DO UPDATE SET value=excluded.value",
            [(series_id, d, v) for d, v in rows],
        )
    return len(rows)


def get_last_date(hass: HomeAssistant, series_id: str) -> str | None:
    with _connect(hass) as conn:
        row = conn.execute(
            "SELECT MAX(obs_date) AS d FROM observations WHERE series_id = ?", (series_id,)
        ).fetchone()
    return row["d"]


def get_series(hass: HomeAssistant, series_id: str) -> list[list]:
    """[[date, value], ...] oldest first — compact for the chart payload."""
    with _connect(hass) as conn:
        return [
            [r["obs_date"], r["value"]]
            for r in conn.execute(
                "SELECT obs_date, value FROM observations WHERE series_id = ? ORDER BY obs_date",
                (series_id,),
            )
        ]


def get_loan(hass: HomeAssistant) -> dict | None:
    with _connect(hass) as conn:
        row = conn.execute("SELECT * FROM loan WHERE id = 1").fetchone()
    return dict(row) if row else None


def save_loan(hass: HomeAssistant, loan: dict) -> None:
    now = datetime.now().isoformat(timespec="seconds")
    cols = ", ".join(LOAN_FIELDS)
    marks = ", ".join("?" for _ in LOAN_FIELDS)
    updates = ", ".join(f"{f}=excluded.{f}" for f in LOAN_FIELDS)
    with _connect(hass) as conn:
        conn.execute(
            f"INSERT INTO loan (id, {cols}, updated_at) VALUES (1, {marks}, ?) "
            f"ON CONFLICT(id) DO UPDATE SET {updates}, updated_at=excluded.updated_at",
            (*(loan[f] for f in LOAN_FIELDS), now),
        )


def get_meta(hass: HomeAssistant, key: str) -> str | None:
    with _connect(hass) as conn:
        row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def set_meta(hass: HomeAssistant, key: str, value: str) -> None:
    with _connect(hass) as conn:
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
