"""Pure-Python parsers for FRED responses (no HA imports, testable standalone).

The public CSV export looks like:

    observation_date,MORTGAGE30US
    2026-09-24,7.03
    2026-10-01,7.28

Older exports used `DATE` as the first header. Days with no value (Treasury
market holidays) come through blank in the CSV and as "." in the JSON API.
"""
from __future__ import annotations

import csv
import io
import json


def _value(raw: str) -> float | None:
    raw = (raw or "").strip()
    if raw in ("", "."):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def parse_csv(text: str) -> list[tuple[str, float]]:
    rows = list(csv.reader(io.StringIO(text)))
    if not rows or len(rows[0]) < 2 or rows[0][0].strip().lower() not in ("observation_date", "date"):
        raise ValueError(f"Unexpected FRED CSV header: {rows[0] if rows else 'empty response'}")
    out = []
    for row in rows[1:]:
        if len(row) < 2:
            continue
        val = _value(row[1])
        if val is not None:
            out.append((row[0].strip(), val))
    return out


def parse_api_json(text: str) -> list[tuple[str, float]]:
    data = json.loads(text)
    if "observations" not in data:
        raise ValueError(f"Unexpected FRED API response: {data.get('error_message', text[:200])}")
    out = []
    for obs in data["observations"]:
        val = _value(obs.get("value"))
        if val is not None:
            out.append((obs["date"], val))
    return out
