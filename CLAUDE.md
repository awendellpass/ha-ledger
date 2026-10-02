# Ledger — Claude Project Conventions

Ledger is a Home Assistant custom integration that watches mortgage rates and works out when refinancing a mortgage would pay off. It tracks the Freddie Mac 30- and 15-year survey rates and the 10-year Treasury, charts them, and compares a refi at today's rates against the user's current loan.

v1 scope: rate tracking + charts, and the refi break-even calculator (30- and 15-year). Deferred: HA sensors, a phone notification when a rate crosses the trigger, and a log of real lender quotes.

## Stack

- **Backend:** Python, SQLite (`database.py`), HA's shared aiohttp session for FRED
- **Frontend:** Vanilla JS, no frameworks or CDN dependencies; the chart is hand-built SVG. Two-file iframe auth pattern: `ledger-panel.js` passes `hass.auth.data.access_token` to `ledger-app.js` via `postMessage`; every fetch sends `Authorization: Bearer`.
- **Data:** FRED (St. Louis Fed). Default is the public CSV export, which needs no key. An optional `fred_api_key` in the `ledger:` block switches to the official JSON API.
- **Deploy:** GitHub `awendellpass/ha-ledger` → HACS custom repository → restart HA. Ask before pushing.

## Configuration

```yaml
ledger:
  # optional — only if the CSV endpoint starts blocking the Pi
  # fred_api_key: !secret ledger_fred_api_key
```

A bare `ledger:` line is valid (`config.get(DOMAIN) or {}` handles the `None`).

## File Structure

```
custom_components/ledger/
  __init__.py   — setup: config, DB init, static path, views, panel, refresh timers
  manifest.json
  const.py      — DOMAIN, FRED series/URLs, history start, refresh interval
  fred.py       — CSV + JSON parsers (no HA imports, testable standalone)
  finance.py    — refi math (no HA imports, testable standalone)
  database.py   — SQLite: observations, loan, meta
  api.py        — FRED fetch, refresh orchestration, loan validation, status payload
  views.py      — REST endpoints
  panel.py      — sidebar panel registration
  frontend/
    ledger-panel.js  — HA web component (iframe + token postMessage)
    ledger-app.html  — markup + all CSS
    ledger-app.js    — app logic + SVG chart
```

## FRED gotchas

Verified against live responses 2026-10-02.

- **Bot protection:** `fred.stlouisfed.org` is behind Akamai. A custom User-Agent (`Ledger-HomeAssistant/1.0`) got **no response at all**, while curl's and HA's default aiohttp UA got 200s. So `_fetch_series` deliberately sends no custom UA. If refreshes start failing with timeouts, set `fred_api_key`.
- **CSV format:** header is `observation_date,<SERIES_ID>` (older exports used `DATE`). Missing days (Treasury holidays) are blank. `cosd=YYYY-MM-DD` sets the start date.
- **JSON API:** `observations[].date/value`; missing values are `"."`. Returns 400 without a key.
- **Series:** `MORTGAGE30US`, `MORTGAGE15US` (weekly, dated Thursdays) and `DGS10` (daily, lags a day or so).

## Refi math (`finance.py`)

- Principal & interest only. Escrow is identical before and after a refi.
- **Loan inputs:** balance, as-of date, rate, monthly P&I, closing costs, break-even target months, and a quote adjustment (the user's real quote minus the survey, 0 by default). Months remaining is derived from balance/rate/payment, and the balance is rolled forward month by month from the as-of date, so the user only has to re-enter it occasionally.
- **Break-even** is interest-based: the first month where cumulative interest saved ≥ closing costs. It is not payment-based, which would flatter a 30-year term reset and break for a 15-year.
- **Baseline for shorter terms:** a 15-year refi is compared against paying the current loan off on the same 15-year schedule, so savings reflect the rate alone.
- **Trigger rate:** bisection for the highest refi rate whose break-even is within the target months, minus the quote adjustment, which converts it to a survey rate. It's capped at current + 3 points (`trigger_capped`).
- Lifetime savings = baseline interest − new interest − closing costs. A 30-year refi can break even and still be negative over its life; the UI says so.

## Treasury signal

The latest PMMS week is dated the day it's published. The 10-year move since that date is the early read on next Thursday's survey. `signal` is only set when the latest Treasury date is **after** the latest survey date. Otherwise the tile shows the day-over-day change, since a "since the survey" comparison would read a false ±0.00.

## Database Schema

- **observations:** `series_id, obs_date, value`, PK `(series_id, obs_date)`. FRED-owned; upserts so revisions win.
- **loan:** single row (`id = 1`): `balance, rate, payment, as_of, closing_costs, target_months, quote_spread, updated_at`. User-owned. It's written only by `POST /loan` and never seeded or touched at startup. Personal data lives only in `/config/ledger.db`, never in the repo.
- **meta:** key/value: `schema_version`, `last_refresh`, `last_error`

## Refresh

- 20s after startup, then every 6h
- First run per series pulls from `HISTORY_START` (2000-01-01); later runs re-pull the last `OVERLAP_DAYS` (30) to catch revisions
- `POST /api/ledger/refresh` refreshes on demand; an asyncio lock serializes overlapping calls
- Failures go to `meta.last_error` and show in the panel footer

## API Endpoints

```
GET   /api/ledger/status   — {today, series, latest, signal, loan, analysis, last_refresh, last_error}
POST  /api/ledger/refresh  — refresh now, returns the same payload
POST  /api/ledger/loan     — save loan form (400 {error} on bad input), returns the same payload
```

`series` is `{id: [[date, value], ...]}` oldest first (all history, ~10k points; the client filters by range).

## Chart

Series colors come from the dataviz reference palette's dark steps (`--s30` blue, `--s15` orange, `--s10` aqua), validated all-pairs against the `#1c1c1e` card surface. There is one y-axis (all series are percents) and direct end labels. The dashed reference line is the user's rate and the dotted one is the 30-yr trigger; their labels are drawn after the series with a halo. The crosshair snaps to the densest visible series (daily Treasury) and shows the last value on or before that date for the weekly series.

## Conventions

- No debug logging left at warning level (refresh success logs at `debug`)
- Schema changes need a migration in `init_db` plus a `SCHEMA_VERSION` bump
- Hard refresh (Ctrl+Shift+R) after frontend changes
- `fred.py` and `finance.py` stay HA-free so they can be tested with plain `python`
