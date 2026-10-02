"""FRED fetching, refresh orchestration, loan validation and the status payload."""
from __future__ import annotations

import asyncio
import logging
import re
from datetime import date, timedelta

import aiohttp
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.util import dt as dt_util

from . import database, finance, fred
from .const import (
    CONF_FRED_API_KEY,
    DEFAULT_QUOTE_SPREAD,
    DEFAULT_TARGET_MONTHS,
    DOMAIN,
    FETCH_TIMEOUT_SECONDS,
    FRED_API_URL,
    FRED_CSV_URL,
    HISTORY_START,
    OVERLAP_DAYS,
    SERIES,
    SERIES_10Y,
    SERIES_15Y,
    SERIES_30Y,
)

_LOGGER = logging.getLogger(__name__)
_LOCK = asyncio.Lock()


async def _fetch_series(hass: HomeAssistant, series_id: str, start: str) -> list[tuple[str, float]]:
    # No custom User-Agent: FRED's CSV endpoint sits behind bot protection
    # that drops unfamiliar agents, while HA's default aiohttp one gets through.
    api_key = hass.data[DOMAIN].get(CONF_FRED_API_KEY)
    if api_key:
        url = FRED_API_URL
        params = {"series_id": series_id, "observation_start": start, "api_key": api_key, "file_type": "json"}
        parse = fred.parse_api_json
    else:
        url = FRED_CSV_URL
        params = {"id": series_id, "cosd": start}
        parse = fred.parse_csv
    session = async_get_clientsession(hass)
    async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=FETCH_TIMEOUT_SECONDS)) as resp:
        resp.raise_for_status()
        text = await resp.text()
    return await hass.async_add_executor_job(parse, text)


async def async_refresh(hass: HomeAssistant) -> dict:
    """Pull every series from FRED. The first run backfills from
    HISTORY_START; later runs re-pull a short overlap so revisions land."""
    async with _LOCK:
        now = dt_util.now().isoformat(timespec="seconds")
        try:
            for series_id in SERIES:
                last = await hass.async_add_executor_job(database.get_last_date, hass, series_id)
                start = (
                    (date.fromisoformat(last) - timedelta(days=OVERLAP_DAYS)).isoformat()
                    if last else HISTORY_START
                )
                rows = await _fetch_series(hass, series_id, start)
                saved = await hass.async_add_executor_job(database.save_observations, hass, series_id, rows)
                _LOGGER.debug("Ledger refresh: %s rows for %s since %s", saved, series_id, start)
            await hass.async_add_executor_job(database.set_meta, hass, "last_refresh", now)
            await hass.async_add_executor_job(database.set_meta, hass, "last_error", "")
        except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as err:
            msg = f"{type(err).__name__}: {err}"
            await hass.async_add_executor_job(database.set_meta, hass, "last_error", msg)
            _LOGGER.warning("Ledger: FRED refresh failed — %s", msg)
    return await async_status(hass)


def _num(body: dict, key: str, label: str, default=None, required: bool = False) -> float | None:
    """Parse a form number the way people type it: '371,621.23', '$2,790.83',
    '5.625%'. Blank → default (or an error if required)."""
    raw = body.get(key)
    text = re.sub(r"[,$%\s]", "", str(raw if raw is not None else ""))
    if not text:
        if required:
            raise ValueError(f"{label} is required.")
        return default
    try:
        return float(text)
    except ValueError:
        raise ValueError(f"{label} isn't a number: {raw}")


def validate_loan(body: dict) -> dict:
    """Coerce and sanity-check the loan form. Raises ValueError with a
    message the panel can show as-is.

    The current mortgage (balance, as-of, rate, payment) is required. The
    refi assumptions are optional: blank closing costs stay None and get
    estimated in finance.py; blank target/spread fall back to defaults."""
    loan = {
        "balance": _num(body, "balance", "Principal balance", required=True),
        "rate": _num(body, "rate", "Interest rate", required=True),
        "payment": _num(body, "payment", "Monthly principal & interest", required=True),
        "closing_costs": _num(body, "closing_costs", "Refi closing costs"),
        "target_months": int(_num(body, "target_months", "Break-even target", DEFAULT_TARGET_MONTHS)),
        "quote_spread": _num(body, "quote_spread", "Quote adjustment", DEFAULT_QUOTE_SPREAD),
    }
    try:
        loan["as_of"] = date.fromisoformat(str(body.get("as_of"))).isoformat()
    except ValueError:
        raise ValueError("Balance as-of date is required.")
    if loan["balance"] <= 0 or loan["payment"] <= 0:
        raise ValueError("Balance and payment must be above zero.")
    if not 0 < loan["rate"] < 20:
        raise ValueError("Rate should be a percent, e.g. 5.625.")
    if (loan["closing_costs"] or 0) < 0 or not 1 <= loan["target_months"] <= 360:
        raise ValueError("Closing costs can't be negative; break-even target is 1–360 months.")
    finance.term_months(loan["balance"], loan["rate"], loan["payment"])  # raises if payment < interest
    return loan


def _latest(series: list[list]) -> dict | None:
    if not series:
        return None
    d, v = series[-1]
    prev = series[-2] if len(series) > 1 else None
    return {
        "date": d,
        "value": v,
        "prev_date": prev[0] if prev else None,
        "change": round(v - prev[1], 3) if prev else None,
    }


def _value_on(series: list[list], iso: str) -> float | None:
    """Last value on or before iso."""
    found = None
    for d, v in series:
        if d > iso:
            break
        found = v
    return found


async def async_status(hass: HomeAssistant) -> dict:
    series = {}
    for series_id in SERIES:
        series[series_id] = await hass.async_add_executor_job(database.get_series, hass, series_id)
    loan = await hass.async_add_executor_job(database.get_loan, hass)
    last_refresh = await hass.async_add_executor_job(database.get_meta, hass, "last_refresh")
    last_error = await hass.async_add_executor_job(database.get_meta, hass, "last_error")

    latest = {sid: _latest(rows) for sid, rows in series.items()}

    # Treasury move since the latest survey week: the early read on where
    # next Thursday's survey is heading.
    signal = None
    l30, l10 = latest[SERIES_30Y], latest[SERIES_10Y]
    if l30 and l10 and l10["date"] > l30["date"]:
        then = _value_on(series[SERIES_10Y], l30["date"])
        if then is not None:
            signal = {"since": l30["date"], "change": round(l10["value"] - then, 3), "as_of": l10["date"]}

    analysis = None
    if loan:
        rates = {
            30: latest[SERIES_30Y]["value"] if latest[SERIES_30Y] else None,
            15: latest[SERIES_15Y]["value"] if latest[SERIES_15Y] else None,
        }
        try:
            analysis = await hass.async_add_executor_job(
                finance.analyze, loan, dt_util.now().date(), rates
            )
        except ValueError as err:
            analysis = {"error": str(err)}

    return {
        "today": dt_util.now().date().isoformat(),
        "series": series,
        "latest": latest,
        "signal": signal,
        "loan": loan,
        "analysis": analysis,
        "last_refresh": last_refresh,
        "last_error": last_error or "",
    }
