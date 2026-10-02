"""Ledger — mortgage rate watcher and refinance calculator for Home Assistant."""
from __future__ import annotations

import logging
import os
from datetime import timedelta

import voluptuous as vol
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.event import async_call_later, async_track_time_interval

from . import api, database
from .const import (
    CONF_FRED_API_KEY,
    DOMAIN,
    FRONTEND_PATH,
    REFRESH_INTERVAL_HOURS,
    STARTUP_DELAY_SECONDS,
)
from .panel import async_register_panel
from .views import async_setup_views

_LOGGER = logging.getLogger(__name__)

# A bare `ledger:` line is enough. `fred_api_key: !secret ledger_fred_api_key`
# is optional and switches fetching to the official FRED API.
CONFIG_SCHEMA = vol.Schema(
    {DOMAIN: vol.Any(None, vol.Schema({vol.Optional(CONF_FRED_API_KEY): cv.string}))},
    extra=vol.ALLOW_EXTRA,
)


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    conf = config.get(DOMAIN) or {}
    hass.data[DOMAIN] = {CONF_FRED_API_KEY: conf.get(CONF_FRED_API_KEY)}
    await hass.async_add_executor_job(database.init_db, hass)

    frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_PATH, frontend_dir, cache_headers=False)]
    )
    async_setup_views(hass)
    await async_register_panel(hass)

    # First pull shortly after startup (a fresh install backfills history
    # from 2000), then on a fixed interval.
    async def _refresh(_now=None):
        await api.async_refresh(hass)

    async_call_later(hass, STARTUP_DELAY_SECONDS, _refresh)
    async_track_time_interval(hass, _refresh, timedelta(hours=REFRESH_INTERVAL_HOURS))

    _LOGGER.info("Ledger loaded")
    return True
