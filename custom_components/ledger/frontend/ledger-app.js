const app = (() => {
  let token = null;
  let data = null;
  let refreshing = false;
  let saving = false;
  let formMsg = { text: '', err: false };
  let draft = null;
  let range = '3Y';
  let retryTimer = null;

  const SERIES = [
    { id: 'MORTGAGE30US', name: '30-yr fixed', short: '30-yr', color: 'var(--s30)' },
    { id: 'MORTGAGE15US', name: '15-yr fixed', short: '15-yr', color: 'var(--s15)' },
    { id: 'DGS10', name: '10-yr Treasury', short: '10-yr Tsy', color: 'var(--s10)' },
  ];
  const RANGES = { '1Y': 1, '3Y': 3, '5Y': 5, '10Y': 10, 'All': null };
  const CLOSE_PTS = 0.5;  // within this of the trigger counts as "getting close"

  // ── Helpers ────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 'YYYY-MM-DD' parsed as a local date (not UTC midnight).
  function toDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function fmtDay(iso, withYear = false) {
    return toDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) });
  }

  const pct = (v, d = 2) => v == null ? '—' : `${v.toFixed(d)}%`;
  const money = v => v == null ? '—' : `${v < 0 ? '−' : ''}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
  const signed = (v, d = 2) => v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : '±'}${Math.abs(v).toFixed(d)}`;

  function months(n) {
    if (n == null) return 'never';
    const y = Math.floor(n / 12), m = n % 12;
    return y ? `${n} mo (${y}y${m ? ` ${m}m` : ''})` : `${n} mo`;
  }

  function ago(iso) {
    if (!iso) return 'never';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs} hr ago`;
    return `${Math.round(hrs / 24)} days ago`;
  }

  async function api(method, path, body) {
    const res = await fetch(`/api/ledger${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  }

  // ── Tiles ──────────────────────────────────────────────────

  function tiles() {
    const t = SERIES.map(s => {
      const l = data.latest[s.id];
      let sub = 'No data yet';
      if (l) {
        if (s.id === 'DGS10' && data.signal) {
          const c = data.signal.change;
          const dir = c > 0.02 ? 'next survey likely higher' : c < -0.02 ? 'next survey likely lower' : 'flat since the survey';
          sub = `<span class="chg num">${signed(c)}</span> since ${fmtDay(data.signal.since)} · ${dir}`;
        } else {
          sub = `<span class="chg num">${signed(l.change)}</span> vs prior ${s.id === 'DGS10' ? 'day' : 'week'} · ${fmtDay(l.date)}`;
        }
      }
      return `<div class="tile">
        <div class="tile-label"><span class="swatch" style="background:${s.color}"></span>${s.name}</div>
        <div class="tile-value num">${l ? pct(l.value) : '—'}</div>
        <div class="tile-sub">${sub}</div>
      </div>`;
    });
    return `<div class="tiles">${t.join('')}</div>`;
  }

  // ── Verdict ────────────────────────────────────────────────

  const costLabel = a => a.closing_costs_estimated ? `~${money(a.closing_costs)} est.` : money(a.closing_costs);

  function verdictCard() {
    const a = data.analysis;
    if (!a || a.error) return '';
    const v = ['30', '15'].map(k => {
      const t = a.terms[k];
      if (t.trigger_survey_rate == null) {
        return `<div class="verdict"><div class="verdict-head"><span class="verdict-term">${k}-year refi</span></div>
          <div class="verdict-line">No rate breaks even within ${a.target_months} months at these closing costs.</div></div>`;
      }
      const trig = t.trigger_capped ? `${pct(t.trigger_survey_rate)} or higher` : `${pct(t.trigger_survey_rate)} or lower`;
      let pill = '<span class="pill wait">○ Not yet</span>';
      if (t.in_range) pill = '<span class="pill go">✓ Refi territory</span>';
      else if (t.gap != null && t.gap <= CLOSE_PTS) pill = '<span class="pill close">▲ Getting close</span>';
      const gap = t.survey_rate == null ? 'No survey rate yet.'
        : t.in_range ? `Survey is at <strong class="num">${pct(t.survey_rate)}</strong> — inside your trigger.`
        : `Survey is at <strong class="num">${pct(t.survey_rate)}</strong>, <strong class="num">${t.gap.toFixed(2)} pts</strong> above.`;
      return `<div class="verdict">
        <div class="verdict-head"><span class="verdict-term">${k}-year refi</span>${pill}</div>
        <div class="verdict-line">Watch for a survey rate of <strong class="num">${trig}</strong>.</div>
        <div class="verdict-line">${gap}</div>
      </div>`;
    });
    return `<div class="card">
      <div class="card-title">Refi trigger · break-even within ${a.target_months} months · ${costLabel(a)} closing costs</div>
      <div class="verdicts">${v.join('')}</div>
    </div>`;
  }

  // ── Chart ──────────────────────────────────────────────────

  function chartCard() {
    const a = data.analysis;
    const refs = [];
    if (data.loan) refs.push('<span><span class="dash"></span>Your rate</span>');
    if (a && !a.error && a.terms['30'].trigger_survey_rate != null) refs.push('<span><span class="dash trig"></span>30-yr trigger</span>');
    return `<div class="card">
      <div class="chart-top">
        <div class="card-title" style="margin:0">Rate history</div>
        <div class="ranges">${Object.keys(RANGES).map(r =>
          `<button class="range ${r === range ? 'on' : ''}" onclick="app.setRange('${r}')">${r}</button>`).join('')}</div>
      </div>
      <div class="legend">
        ${SERIES.map(s => `<span><span class="swatch" style="background:${s.color}"></span>${s.name}</span>`).join('')}
        ${refs.join('')}
      </div>
      <div class="chart-wrap">
        <svg id="chart" role="img" aria-label="Mortgage and Treasury rate history"></svg>
        <div class="tip" id="tip"></div>
      </div>
      <div class="note" style="margin-top:6px">Freddie Mac survey (weekly, Thursdays) and 10-year Treasury yield (daily), via FRED.</div>
    </div>`;
  }

  // Index of the last point on or before t (points sorted by t).
  function lastAtOrBefore(pts, t) {
    let lo = 0, hi = pts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function niceStep(span) {
    for (const s of [0.25, 0.5, 1, 2]) if (span / s <= 6) return s;
    return 2;
  }

  function drawChart() {
    const svg = document.getElementById('chart');
    if (!svg || !data) return;
    const W = svg.clientWidth || 600, H = 280;
    const pad = { l: 40, r: 72, t: 10, b: 24 };
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const years = RANGES[range];
    const end = toDate(data.today).getTime();
    const start = years ? end - years * 365.25 * 864e5 : null;

    const series = SERIES.map(s => {
      const all = (data.series[s.id] || []).map(([d, v]) => ({ t: toDate(d).getTime(), d, v }));
      return { ...s, pts: start ? all.filter(p => p.t >= start) : all };
    }).filter(s => s.pts.length);

    if (!series.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">No data yet</text>`;
      return;
    }

    const a = data.analysis;
    const refs = [];
    if (data.loan) refs.push({ v: data.loan.rate, label: `Your rate ${pct(data.loan.rate, 3)}`, cls: '6 4' });
    const trig = a && !a.error ? a.terms['30'].trigger_survey_rate : null;
    if (trig != null) refs.push({ v: trig, label: `30-yr trigger ${pct(trig)}`, cls: '2 3' });

    const t0 = start ?? Math.min(...series.map(s => s.pts[0].t));
    const t1 = Math.max(...series.map(s => s.pts[s.pts.length - 1].t));
    const vals = series.flatMap(s => s.pts.map(p => p.v)).concat(refs.map(r => r.v));
    const step = niceStep(Math.max(...vals) - Math.min(...vals));
    const y0 = Math.floor(Math.min(...vals) / step) * step;
    const y1 = Math.ceil(Math.max(...vals) / step) * step || y0 + step;

    const X = t => pad.l + (t - t0) / Math.max(1, t1 - t0) * (W - pad.l - pad.r);
    const Y = v => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);

    let out = '';
    // Grid + y labels
    for (let v = y0; v <= y1 + 1e-9; v += step) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
      out += `<text x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(step < 1 ? 2 : 0)}%</text>`;
    }
    // X labels: years, or months for short spans
    const spanYears = (t1 - t0) / (365.25 * 864e5);
    const d0 = new Date(t0), ticks = [];
    if (spanYears <= 1.5) {
      for (let d = new Date(d0.getFullYear(), d0.getMonth() + 1, 1); d.getTime() <= t1; d.setMonth(d.getMonth() + (spanYears > 0.75 ? 2 : 1)))
        ticks.push([d.getTime(), d.toLocaleDateString('en-US', { month: 'short' }) + (d.getMonth() === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : '')]);
    } else {
      const every = spanYears > 12 ? 4 : spanYears > 6 ? 2 : 1;
      for (let y = d0.getFullYear() + 1; new Date(y, 0, 1).getTime() <= t1; y++)
        if (y % every === 0) ticks.push([new Date(y, 0, 1).getTime(), String(y)]);
    }
    for (const [t, label] of ticks) out += `<text x="${X(t)}" y="${H - 6}" text-anchor="middle">${label}</text>`;

    // Reference lines with direct labels (left, above the line)
    for (const r of refs) {
      out += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${Y(r.v)}" y2="${Y(r.v)}" stroke="var(--text2)" stroke-opacity="0.7" stroke-width="1.5" stroke-dasharray="${r.cls}"/>`;
    }

    // Series lines
    for (const s of series) {
      const d = s.pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
      out += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    }

    // Reference labels go on top of the series, haloed so lines don't cut through them
    for (const r of refs) out += `<text class="halo" x="${pad.l + 6}" y="${Y(r.v) - 5}">${r.label}</text>`;

    // Direct end labels, nudged apart so they don't collide
    const ends = series.map(s => ({ s, y: Y(s.pts[s.pts.length - 1].v) })).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) {
      const last = e.s.pts[e.s.pts.length - 1];
      out += `<circle cx="${X(last.t)}" cy="${Y(last.v)}" r="3.5" fill="${e.s.color}" stroke="var(--card)" stroke-width="2"/>`;
      out += `<text class="lbl" x="${W - pad.r + 8}" y="${e.y + 4}">${e.s.short}</text>`;
    }

    // Crosshair + hit area
    out += `<line id="xh" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>`;
    out += `<g id="xhdots"></g>`;
    out += `<rect id="hit" x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="transparent"/>`;
    svg.innerHTML = out;

    // Snap to the densest series (daily Treasury when present)
    const dense = series.reduce((a, b) => (b.pts.length > a.pts.length ? b : a));
    const hit = svg.querySelector('#hit'), xh = svg.querySelector('#xh'), dots = svg.querySelector('#xhdots');
    const tip = document.getElementById('tip');

    function move(ev) {
      const box = svg.getBoundingClientRect();
      const px = (ev.clientX - box.left) * (W / box.width);
      const t = t0 + (px - pad.l) / (W - pad.l - pad.r) * (t1 - t0);
      let i = lastAtOrBefore(dense.pts, t);
      if (i < 0) i = 0;
      if (i + 1 < dense.pts.length && Math.abs(dense.pts[i + 1].t - t) < Math.abs(dense.pts[i].t - t)) i++;
      const snap = dense.pts[i];
      const x = X(snap.t);
      xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');

      let rows = '', circles = '';
      for (const s of series) {
        const j = lastAtOrBefore(s.pts, snap.t);
        if (j < 0) continue;
        const p = s.pts[j];
        circles += `<circle cx="${x}" cy="${Y(p.v)}" r="4" fill="${s.color}" stroke="var(--card)" stroke-width="2"/>`;
        rows += `<div class="tip-row"><span class="k"><span class="swatch" style="background:${s.color}"></span>${s.short}</span><b class="num">${pct(p.v)}</b></div>`;
      }
      dots.innerHTML = circles;
      tip.innerHTML = `<div class="tip-date">${fmtDay(snap.d, true)}</div>${rows}`;
      tip.style.display = 'block';
      const left = x * (box.width / W);
      const tw = tip.offsetWidth;
      tip.style.left = `${left + 12 + tw > box.width ? left - tw - 12 : left + 12}px`;
    }
    function leave() {
      xh.setAttribute('visibility', 'hidden');
      dots.innerHTML = '';
      tip.style.display = 'none';
    }
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
  }

  // ── Refi comparison ────────────────────────────────────────

  function compareCard() {
    const a = data.analysis;
    if (!a) return '';
    if (a.error) return `<div class="card"><div class="card-title">Refi math</div><div class="form-msg err">${esc(a.error)}</div></div>`;
    const c = a.current, t30 = a.terms['30'], t15 = a.terms['15'];
    const cell = (t, f) => (t.survey_rate == null ? '—' : f(t));
    const sav = v => `<span class="${v > 0 ? 'good' : 'bad'}">${money(v)}</span>`;
    const change = v => `${v > 0 ? '+' : '−'}${money(Math.abs(v))}`;
    const rows = [
      ['Rate', pct(c.rate, 3), cell(t30, t => pct(t.loan_rate, 3)), cell(t15, t => pct(t.loan_rate, 3))],
      ['Monthly P&amp;I', money(c.payment), cell(t30, t => money(t.payment)), cell(t15, t => money(t.payment))],
      ['Payment change', '', cell(t30, t => change(t.payment_change)), cell(t15, t => change(t.payment_change))],
      ['Break-even', '', cell(t30, t => months(t.breakeven_months)), cell(t15, t => months(t.breakeven_months))],
      ['Interest left', money(c.interest_remaining), cell(t30, t => money(t.interest_total)), cell(t15, t => money(t.interest_total))],
      ['Lifetime savings*', '', cell(t30, t => sav(t.net_savings)), cell(t15, t => sav(t.net_savings))],
    ];
    const spread = data.loan.quote_spread ? ` plus your ${signed(data.loan.quote_spread)} pt quote adjustment` : '';
    return `<div class="card">
      <div class="card-title">Refi at today's rates</div>
      <div class="scroll"><table>
        <thead><tr><th></th><th>Current</th><th>30-yr refi</th><th>15-yr refi</th></tr></thead>
        <tbody>${rows.map(r => `<tr>${r.map((v, i) => i ? `<td class="num">${v}</td>` : `<td>${v}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p class="note" style="margin-top:10px">
        Balance ${money(c.balance)} with ${months(c.months_remaining)} left (rolled forward from your ${fmtDay(data.loan.as_of, true)} entry).
        Refi rates are the survey average${spread}, with ${money(a.closing_costs)} in closing costs paid upfront.
        ${a.closing_costs_estimated ? `That's an estimate at ${a.estimated_cost_pct}% of the balance; a lender's figure under Refi assumptions will sharpen it.` : ''}
        Principal &amp; interest only — taxes and insurance don't change.
      </p>
      <p class="note" style="margin-top:6px">
        Break-even is the month the interest you save covers the closing costs.
        *Interest saved minus closing costs over the life of the loan. A 30-year refi restarts the clock, so it can break even and still cost more in the long run.
        The 15-year is compared against paying your current loan off on the same 15-year schedule, so its savings come from the rate alone.
      </p>
    </div>`;
  }

  // ── Loan form ──────────────────────────────────────────────

  function loanForm() {
    const l = draft || data.loan || {};
    const val = (k, d = '') => esc(l[k] ?? d);
    const field = (k, label, hint, attrs) => `
      <div class="field">
        <label for="f-${k}">${label}</label>
        <input id="f-${k}" ${attrs} value="${val(k, k === 'as_of' ? data.today : '')}">
        ${hint ? `<div class="hint">${hint}</div>` : ''}
      </div>`;
    return `<details class="panel" ${data.loan ? '' : 'open'}>
      <summary>Your loan</summary>
      <div class="panel-body">
        ${data.loan ? '' : '<p class="note" style="margin-bottom:12px">Enter your current mortgage to see the refi math. Stored only in Home Assistant.</p>'}
        <div class="form-group">Your mortgage</div>
        <div class="form">
          ${field('balance', 'Principal balance', 'From your latest statement', 'type="text" inputmode="decimal" autocomplete="off"')}
          ${field('as_of', 'Balance as of', 'Ledger rolls the balance forward from here', 'type="date"')}
          ${field('rate', 'Interest rate (%)', '', 'type="text" inputmode="decimal" autocomplete="off"')}
          ${field('payment', 'Monthly principal &amp; interest', 'Leave out escrow (taxes/insurance)', 'type="text" inputmode="decimal" autocomplete="off"')}
        </div>
        <div class="form-group">Refi assumptions <span>optional — leave blank for defaults</span></div>
        <div class="form">
          ${field('closing_costs', 'Refi closing costs', 'Fees on the new loan (appraisal, title, origination). Blank = estimate at 2% of your balance', 'type="text" inputmode="decimal" autocomplete="off" placeholder="Estimate"')}
          ${field('target_months', 'Break-even target (months)', 'How soon the refi must pay for itself — about how long you\'ll stay', 'type="text" inputmode="decimal" autocomplete="off" placeholder="36"')}
          ${field('quote_spread', 'Quote adjustment (pts)', 'A real quote minus the survey rate, once you have one', 'type="text" inputmode="decimal" autocomplete="off" placeholder="0"')}
        </div>
        <div class="form-actions">
          <button class="btn primary" onclick="app.saveLoan()" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>
          <span class="form-msg ${formMsg.err ? 'err' : ''}">${esc(formMsg.text)}</span>
        </div>
      </div>
    </details>`;
  }

  // ── Data table (accessible view of the chart) ──────────────

  function dataTable() {
    const s30 = data.series.MORTGAGE30US || [];
    if (!s30.length) return '';
    const idx = id => Object.fromEntries(data.series[id] || []);
    const m15 = idx('MORTGAGE15US'), t10 = data.series.DGS10 || [];
    const tsy = iso => { let v = null; for (const [d, x] of t10) { if (d > iso) break; v = x; } return v; };
    const rows = s30.slice(-12).reverse().map(([d, v]) =>
      `<tr><td>${fmtDay(d, true)}</td><td class="num">${pct(v)}</td><td class="num">${pct(m15[d])}</td><td class="num">${pct(tsy(d))}</td></tr>`);
    return `<details class="panel">
      <summary>Last 12 survey weeks</summary>
      <div class="panel-body scroll"><table>
        <thead><tr><th>Week</th><th>30-yr</th><th>15-yr</th><th>10-yr Tsy</th></tr></thead>
        <tbody>${rows.join('')}</tbody>
      </table></div>
    </details>`;
  }

  // ── Render ─────────────────────────────────────────────────

  function render() {
    const main = document.getElementById('main');
    const header = `
      <header>
        <div>
          <h1>Ledger</h1>
          <div class="sub">Mortgage rates &amp; refi watch</div>
        </div>
        <button class="btn" onclick="app.refresh()" ${refreshing ? 'disabled' : ''}>${refreshing ? 'Refreshing…' : 'Refresh'}</button>
      </header>`;

    if (!data) {
      main.innerHTML = header + '<div class="empty">Loading…</div>';
      return;
    }

    const status = data.last_error
      ? `<div class="status err">Last refresh failed: ${esc(data.last_error)}</div>`
      : `<div class="status">Updated ${ago(data.last_refresh)} · source: Freddie Mac PMMS &amp; U.S. Treasury via FRED<br>Survey averages are for strong-credit borrowers paying ~0.7 points — your quote will differ.</div>`;

    if (!data.latest.MORTGAGE30US && !data.last_refresh) {
      main.innerHTML = header + '<div class="empty">Pulling rate history from FRED for the first time…</div>' + status;
      return;
    }

    main.innerHTML = header + tiles() + verdictCard() + chartCard() + compareCard() + loanForm() + dataTable() + status;
    drawChart();
  }

  // ── Actions ────────────────────────────────────────────────

  async function load() {
    try {
      data = await api('GET', '/status');
    } catch (e) {
      data = data || { series: {}, latest: {}, loan: null, analysis: null, last_refresh: null, last_error: e.message, today: new Date().toISOString().slice(0, 10) };
    }
    render();
    // On a fresh install the first fetch runs ~20s after HA starts; check back once.
    clearTimeout(retryTimer);
    if (!data.last_refresh) retryTimer = setTimeout(load, 25000);
  }

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    render();
    try {
      data = await api('POST', '/refresh');
    } catch (e) {
      if (data) data.last_error = e.message;
    }
    refreshing = false;
    render();
  }

  async function saveLoan() {
    if (saving) return;
    const body = {};
    for (const k of ['balance', 'as_of', 'rate', 'payment', 'closing_costs', 'target_months', 'quote_spread'])
      body[k] = document.getElementById(`f-${k}`).value;
    saving = true;
    try {
      data = await api('POST', '/loan', body);
      formMsg = { text: 'Saved', err: false };
      draft = null;
    } catch (e) {
      formMsg = { text: e.message, err: true };
      draft = body;  // keep what was typed
    }
    saving = false;
    render();
    document.querySelector('details.panel').open = true;
  }

  function setRange(r) {
    range = r;
    document.querySelectorAll('.range').forEach(b => b.classList.toggle('on', b.textContent === r));
    drawChart();
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawChart, 150);
  });

  // ── Boot ───────────────────────────────────────────────────

  let initialized = false;
  window.addEventListener('message', e => {
    if (e.data?.type === 'auth' && e.data.token) {
      token = e.data.token;
      if (!initialized) {
        initialized = true;
        load();
      }
    }
  });

  return { refresh, saveLoan, setRange };
})();
