# Ledger

A Home Assistant integration for keeping an eye on mortgage rates and spotting a good time to refinance.

- Tracks the Freddie Mac 30- and 15-year fixed rates (weekly) and the 10-year Treasury yield (daily) from FRED, with history back to 2000
- Charts them against your current rate and your refi trigger rate
- Compares a 30- or 15-year refi at today's rates against your loan: new payment, interest break-even, lifetime savings
- Works out the **trigger rate**: the survey rate at which a refi pays for itself within the number of months you choose

Your loan details are stored only in Home Assistant's `/config/ledger.db`.

## Install

1. HACS → Custom repositories → add `https://github.com/awendellpass/ha-ledger` (Integration) → install **Ledger**
2. Add to `configuration.yaml`:
   ```yaml
   ledger:
   ```
3. Restart Home Assistant and open **Ledger** in the sidebar. Rate history loads about 20 seconds after startup.
4. Open **Your loan**, enter your current balance, rate and monthly principal & interest, then save. The refi assumptions (closing costs, break-even target, quote adjustment) are optional; blank closing costs are estimated at 2% of your balance.

No API key is needed. If FRED ever starts refusing requests, get a free key at https://fred.stlouisfed.org/docs/api/api_key.html and add it:

```yaml
ledger:
  fred_api_key: !secret ledger_fred_api_key
```

## Caveats

Freddie Mac's survey averages rates for strong-credit borrowers paying about 0.7 points. Your real quote will differ. Once you have one, set **Quote adjustment** to the difference and the trigger and comparison will shift to match.
