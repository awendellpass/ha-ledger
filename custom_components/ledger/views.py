"""HTTP API views for Ledger."""
from __future__ import annotations

from homeassistant.components.http import HomeAssistantView
from homeassistant.core import HomeAssistant

from . import api, database
from .const import API_BASE


def async_setup_views(hass: HomeAssistant) -> None:
    hass.http.register_view(LedgerStatusView)
    hass.http.register_view(LedgerRefreshView)
    hass.http.register_view(LedgerLoanView)


# ---------------------------------------------------------------------------
# GET  /api/ledger/status   — rate history, latest values, loan + analysis
# ---------------------------------------------------------------------------

class LedgerStatusView(HomeAssistantView):
    url = f"{API_BASE}/status"
    name = "api:ledger:status"
    requires_auth = True

    async def get(self, request):
        return self.json(await api.async_status(request.app["hass"]))


# ---------------------------------------------------------------------------
# POST /api/ledger/refresh  — pull FRED now, return the fresh status
# ---------------------------------------------------------------------------

class LedgerRefreshView(HomeAssistantView):
    url = f"{API_BASE}/refresh"
    name = "api:ledger:refresh"
    requires_auth = True

    async def post(self, request):
        return self.json(await api.async_refresh(request.app["hass"]))


# ---------------------------------------------------------------------------
# POST /api/ledger/loan     — save the loan form, return the fresh status
# ---------------------------------------------------------------------------

class LedgerLoanView(HomeAssistantView):
    url = f"{API_BASE}/loan"
    name = "api:ledger:loan"
    requires_auth = True

    async def post(self, request):
        hass = request.app["hass"]
        try:
            loan = api.validate_loan(await request.json())
        except ValueError as err:
            return self.json({"error": str(err)}, status_code=400)
        await hass.async_add_executor_job(database.save_loan, hass, loan)
        return self.json(await api.async_status(hass))
