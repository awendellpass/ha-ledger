"""Constants for the Ledger integration."""

DOMAIN = "ledger"
DB_NAME = "ledger.db"
FRONTEND_PATH = "/ledger_frontend"
API_BASE = "/api/ledger"

# Optional. Without a key Ledger reads FRED's public CSV export; with one it
# uses the official FRED API instead (a fallback if the CSV endpoint's bot
# protection ever starts blocking the Pi).
CONF_FRED_API_KEY = "fred_api_key"

# FRED series. Freddie Mac's PMMS survey is weekly (Thursdays); the 10-year
# Treasury is daily and usually moves before the survey does.
SERIES_30Y = "MORTGAGE30US"
SERIES_15Y = "MORTGAGE15US"
SERIES_10Y = "DGS10"
SERIES = [SERIES_30Y, SERIES_15Y, SERIES_10Y]

FRED_CSV_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv"
FRED_API_URL = "https://api.stlouisfed.org/fred/series/observations"
FETCH_TIMEOUT_SECONDS = 30

# First run pulls everything from here; later runs re-pull only a short
# overlap window so FRED's occasional revisions are picked up.
HISTORY_START = "2000-01-01"
OVERLAP_DAYS = 30

REFRESH_INTERVAL_HOURS = 6
STARTUP_DELAY_SECONDS = 20

# Defaults for the loan form; the user owns these once saved.
DEFAULT_TARGET_MONTHS = 36
