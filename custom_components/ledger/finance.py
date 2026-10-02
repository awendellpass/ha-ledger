"""Refinance math (no HA imports, testable standalone).

Everything here is principal & interest only. Taxes, insurance and escrow are
the same before and after a refi, so they don't change the comparison.

Break-even is measured on interest, not on monthly payment: it's the month
where the interest you'd have saved finally covers the closing costs. A
payment-based break-even flatters a 30-year refi (part of the lower payment
is just the term resetting) and makes no sense for a 15-year (whose payment
usually goes up).

A shorter refi term is compared against paying the current loan off on that
same shorter schedule, so the savings shown come from the rate alone, not
from paying faster (which prepaying the current loan would also get you).
"""
from __future__ import annotations

import math
from datetime import date

# Refi closing costs when the user hasn't entered a figure: typical range is
# 2–5% of the loan, so 2% is the optimistic end (it gives an earlier trigger).
ESTIMATED_COST_PCT = 2.0


def months_between(start: date, end: date) -> int:
    """Whole calendar months from start's month to end's month."""
    return (end.year - start.year) * 12 + (end.month - start.month)


def term_months(principal: float, rate_pct: float, pmt: float) -> int:
    """Payments left on a loan, from its balance, rate and P&I payment."""
    r = rate_pct / 100 / 12
    if r == 0:
        return math.ceil(principal / pmt)
    if pmt <= principal * r:
        raise ValueError("Payment doesn't cover the monthly interest")
    return math.ceil(-math.log(1 - principal * r / pmt) / math.log(1 + r) - 1e-6)


def _add_months(d: date, n: int) -> str:
    m = d.year * 12 + d.month - 1 + n
    return f"{m // 12:04d}-{m % 12 + 1:02d}"


def payment(principal: float, rate_pct: float, months: int) -> float:
    if months <= 0 or principal <= 0:
        return 0.0
    r = rate_pct / 100 / 12
    if r == 0:
        return principal / months
    return principal * r / (1 - (1 + r) ** -months)


def _interest_schedule(principal: float, rate_pct: float, pmt: float, months: int) -> list[float]:
    r = rate_pct / 100 / 12
    bal, out = principal, []
    for _ in range(months):
        if bal <= 0.005:
            break
        interest = bal * r
        bal = bal + interest - pmt
        out.append(interest)
    return out


def _balance_after(principal: float, rate_pct: float, pmt: float, months: int) -> float:
    r = rate_pct / 100 / 12
    bal = principal
    for _ in range(months):
        bal = bal * (1 + r) - pmt
        if bal <= 0:
            return 0.0
    return bal


def _breakeven(cur_int: list[float], new_int: list[float], costs: float) -> int | None:
    cum = 0.0
    for m in range(max(len(cur_int), len(new_int))):
        cum += (cur_int[m] if m < len(cur_int) else 0) - (new_int[m] if m < len(new_int) else 0)
        if cum >= costs:
            return m + 1
    return None


def current_loan(loan: dict, today: date) -> dict:
    """Roll the saved loan forward from its as-of date to today."""
    as_of = date.fromisoformat(loan["as_of"])
    pmt = loan["payment"]
    remaining_at_asof = term_months(loan["balance"], loan["rate"], pmt)
    elapsed = max(0, min(months_between(as_of, today), remaining_at_asof))
    balance = _balance_after(loan["balance"], loan["rate"], pmt, elapsed)
    remaining = remaining_at_asof - elapsed
    return {
        "balance": round(balance, 2),
        "rate": loan["rate"],
        "payment": round(pmt, 2),
        "months_remaining": remaining,
        "interest_remaining": round(sum(_interest_schedule(balance, loan["rate"], pmt, remaining)), 2),
        # Next payment is due next month, so the last one lands `remaining`
        # months after this one. Lets the user check against their servicer.
        "payoff_month": _add_months(today, remaining),
    }


def _baseline_interest(cur: dict, term: int) -> list[float]:
    """Current loan's interest, paid off within `term` months if that's
    sooner than its own schedule."""
    months = min(term, cur["months_remaining"])
    pmt = max(cur["payment"], payment(cur["balance"], cur["rate"], months))
    return _interest_schedule(cur["balance"], cur["rate"], pmt, months)


def _scenario(cur: dict, base_int: list[float], loan_rate: float, term: int, costs: float) -> dict:
    pmt = payment(cur["balance"], loan_rate, term)
    new_int = _interest_schedule(cur["balance"], loan_rate, pmt, term)
    return {
        "payment": pmt,
        "interest": new_int,
        "breakeven": _breakeven(base_int, new_int, costs),
    }


def _trigger_rate(cur: dict, base_int: list[float], term: int, costs: float, target: int) -> tuple[float | None, bool]:
    """Highest loan rate whose break-even is within `target` months.
    Returns (rate, capped) — capped means even current+3 points qualifies."""
    def ok(rate: float) -> bool:
        be = _scenario(cur, base_int, rate, term, costs)["breakeven"]
        return be is not None and be <= target

    lo, hi = 0.0, cur["rate"] + 3
    if not ok(lo):
        return None, False
    if ok(hi):
        return hi, True
    for _ in range(40):
        mid = (lo + hi) / 2
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo, False


def analyze(loan: dict, today: date, survey_rates: dict[int, float | None]) -> dict:
    """Compare the current loan against a refi at today's survey rate for
    each term in survey_rates ({30: 7.28, 15: 6.60})."""
    cur = current_loan(loan, today)
    spread = loan.get("quote_spread") or 0.0
    costs_estimated = loan.get("closing_costs") is None
    costs = round(cur["balance"] * ESTIMATED_COST_PCT / 100, -2) if costs_estimated else loan["closing_costs"]
    target = loan["target_months"]

    terms = {}
    for years, survey in survey_rates.items():
        term = years * 12
        base_int = _baseline_interest(cur, term)
        trig, capped = _trigger_rate(cur, base_int, term, costs, target)
        trigger_survey = round(trig - spread, 3) if trig is not None else None
        result = {
            "years": years,
            "survey_rate": survey,
            "trigger_survey_rate": trigger_survey,
            "trigger_capped": capped,
            "baseline_accelerated": term < cur["months_remaining"],
        }
        if survey is not None:
            rate = survey + spread
            s = _scenario(cur, base_int, rate, term, costs)
            new_total = sum(s["interest"])
            result.update({
                "loan_rate": round(rate, 3),
                "payment": round(s["payment"], 2),
                "payment_change": round(s["payment"] - cur["payment"], 2),
                "breakeven_months": s["breakeven"],
                "interest_total": round(new_total, 2),
                "net_savings": round(sum(base_int) - new_total - costs, 2),
                "gap": round(survey - trigger_survey, 3) if trigger_survey is not None else None,
                "in_range": trigger_survey is not None and survey <= trigger_survey,
            })
        terms[str(years)] = result

    return {
        "current": cur,
        "terms": terms,
        "closing_costs": costs,
        "closing_costs_estimated": costs_estimated,
        "estimated_cost_pct": ESTIMATED_COST_PCT,
        "target_months": target,
    }
