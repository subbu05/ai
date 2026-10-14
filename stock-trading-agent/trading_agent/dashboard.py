"""Self-contained HTML P&L dashboard (no external libraries, works offline).

    python -m trading_agent report            # writes reports/pnl_dashboard.html

Charts: cumulative realized P&L, daily realized P&L, realized P&L by symbol, equity curve,
and the tracked daily prices of each holding against its cost basis.
"""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

from .pnl import EquityHistory, PnlLedger, realized_trades, summarize


def build_data(broker, data_dir: Path, mode: str) -> dict:
    ledger = PnlLedger(data_dir / "fills.jsonl")
    ledger.sync(broker)
    fills = ledger.fills()
    trades = realized_trades(fills)
    summary = summarize(trades)
    positions = broker.get_positions()

    from .monitor import PriceTracker

    tracker = PriceTracker(data_dir / "price_tracker.json", data_dir / "price_log.jsonl")
    daily: dict[str, dict[str, dict]] = defaultdict(dict)   # symbol -> date -> ohlc + cost
    for r in tracker.log_rows():
        d = daily[r["symbol"]].setdefault(r["date"], {"open": r["price"], "high": r["price"],
                                                       "low": r["price"], "close": r["price"]})
        d["high"], d["low"], d["close"] = max(d["high"], r["price"]), min(d["low"], r["price"]), r["price"]
        d["cost"] = r["avg_cost"]
    sells = defaultdict(list)
    for f in fills:
        if f.side.value == "sell":
            sells[f.symbol].append({"date": f.timestamp.date().isoformat(), "price": f.price, "qty": f.qty})

    held = {p.symbol: p for p in positions}
    price_series = []
    for sym in sorted(daily):
        rows = [{"date": d, **v} for d, v in sorted(daily[sym].items())]
        pos = held.get(sym)
        price_series.append({"symbol": sym, "rows": rows, "sells": sells.get(sym, []),
                             "cost": pos.avg_entry_price if pos else rows[-1].get("cost"),
                             "held": bool(pos)})

    equity = EquityHistory(data_dir / "equity_history.jsonl").rows()
    return {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "mode": mode,
        "broker": broker.name,
        "summary": {k: v for k, v in summary.items() if k not in ("by_symbol", "by_day")},
        "unrealized": round(sum(p.unrealized_pl for p in positions), 2),
        "by_day": summary["by_day"],
        "by_symbol": [{"label": k, "value": v} for k, v in summary["by_symbol"].items()],
        "equity": [{"x": r["ts"][:10], "y": r["equity"]} for r in equity],
        "prices": price_series,
        "trades": [t.to_dict() for t in trades][-200:],
        "positions": [p.to_dict() for p in positions],
    }


def render(data: dict) -> str:
    payload = json.dumps(data, default=str).replace("</", "<\\/")
    return TEMPLATE.replace("__DATA__", payload)


def write_dashboard(broker, data_dir: Path, out: Path, mode: str) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(render(build_data(broker, data_dir, mode)))
    return out


TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>P&amp;L Dashboard</title>
<style>
:root {
  color-scheme: light;
  --surface-0: #f4f3f0; --surface-1: #fcfcfb; --border: #e2e1dc;
  --text-primary: #0b0b0b; --text-secondary: #52514e; --text-muted: #898781;
  --grid: #e9e8e3; --axis: #c3c2b7;
  --gain: #2a78d6; --loss: #e34948; --gain-wash: rgba(42,120,214,.10);
  --line: #2a78d6; --ref: #898781;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --surface-0: #111110; --surface-1: #1a1a19; --border: #2c2c2a;
    --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
    --grid: #2a2a28; --axis: #383835;
    --gain: #3987e5; --loss: #e66767; --gain-wash: rgba(57,135,229,.12);
    --line: #3987e5; --ref: #898781;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --surface-0: #111110; --surface-1: #1a1a19; --border: #2c2c2a;
  --text-primary: #f0efec; --text-secondary: #c3c2b7; --text-muted: #898781;
  --grid: #2a2a28; --axis: #383835;
  --gain: #3987e5; --loss: #e66767; --gain-wash: rgba(57,135,229,.12);
  --line: #3987e5; --ref: #898781;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--surface-0); color: var(--text-primary);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1120px; margin: 0 auto; padding: 24px 16px 48px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; flex-wrap: wrap; }
h1 { font-size: 20px; margin: 0; font-weight: 600; }
h2 { font-size: 15px; margin: 0 0 2px; font-weight: 600; }
.sub { color: var(--text-secondary); font-size: 13px; margin: 0 0 12px; }
.meta { color: var(--text-muted); font-size: 12px; }
button.theme { background: var(--surface-1); color: var(--text-secondary); border: 1px solid var(--border);
  border-radius: 6px; padding: 4px 10px; font: inherit; font-size: 12px; cursor: pointer; }
.hero { margin: 20px 0 12px; }
.hero .label { color: var(--text-secondary); font-size: 13px; }
.hero .value { font-size: 52px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.1; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
.tile, .card { background: var(--surface-1); border: 1px solid var(--border); border-radius: 10px; }
.tile { padding: 12px 14px; }
.tile .label { color: var(--text-secondary); font-size: 12px; }
.tile .value { font-size: 22px; font-weight: 600; margin-top: 2px; }
.tile .note { color: var(--text-muted); font-size: 12px; }
.sign { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 16px; }
.card { padding: 16px; margin-bottom: 16px; position: relative; min-width: 0; }
.chart { width: 100%; position: relative; }
.chart svg { display: block; width: 100%; overflow: visible; }
.empty { color: var(--text-muted); padding: 24px 0; text-align: center; }
.legend { display: flex; gap: 14px; flex-wrap: wrap; color: var(--text-secondary); font-size: 12px; margin-bottom: 6px; }
.legend i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
.legend i.box { height: 10px; width: 10px; }
.tip { position: absolute; pointer-events: none; background: var(--surface-1); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; white-space: nowrap;
  box-shadow: 0 2px 8px rgba(0,0,0,.12); display: none; z-index: 2; }
.tip b { font-weight: 600; }
.multiples { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 16px; }
details { margin-top: 10px; }
summary { color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.tablewrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 12px; margin-top: 8px; font-variant-numeric: tabular-nums; }
th, td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
th { color: var(--text-secondary); font-weight: 600; }
text { fill: var(--text-muted); font-size: 11px; }
text.val { fill: var(--text-secondary); paint-order: stroke; stroke: var(--surface-1); stroke-width: 3px; stroke-linejoin: round; }
</style>
</head>
<body>
<main>
  <header>
    <h1>Trading P&amp;L</h1>
    <div class="meta"><span id="meta"></span>
      <button class="theme" id="themeBtn" type="button">Theme</button></div>
  </header>

  <section class="hero">
    <div class="label">Net realized P&amp;L</div>
    <div class="value" id="heroValue">-</div>
  </section>
  <section class="tiles" id="tiles"></section>

  <div class="grid2">
    <section class="card">
      <h2>Cumulative realized P&amp;L</h2>
      <p class="sub">Running total of closed-trade profit and loss</p>
      <div class="chart" id="cumChart"></div>
      <details><summary>Table view</summary><div class="tablewrap" id="cumTable"></div></details>
    </section>
    <section class="card">
      <h2>Daily realized P&amp;L</h2>
      <p class="sub">Profit and loss booked each day</p>
      <div class="legend"><span><i class="box" style="background:var(--gain)"></i>Profit</span><span><i class="box" style="background:var(--loss)"></i>Loss</span></div>
      <div class="chart" id="dayChart"></div>
      <details><summary>Table view</summary><div class="tablewrap" id="dayTable"></div></details>
    </section>
    <section class="card">
      <h2>Realized P&amp;L by symbol</h2>
      <p class="sub">Which holdings made or lost money</p>
      <div class="legend"><span><i class="box" style="background:var(--gain)"></i>Profit</span><span><i class="box" style="background:var(--loss)"></i>Loss</span></div>
      <div class="chart" id="symChart"></div>
      <details><summary>Table view</summary><div class="tablewrap" id="symTable"></div></details>
    </section>
    <section class="card">
      <h2>Account equity</h2>
      <p class="sub">Snapshots taken by the price monitor</p>
      <div class="chart" id="eqChart"></div>
      <details><summary>Table view</summary><div class="tablewrap" id="eqTable"></div></details>
    </section>
  </div>

  <section class="card">
    <h2>Tracked daily prices</h2>
    <p class="sub">Daily close of each holding against its average cost; dots mark sells</p>
    <div class="legend"><span><i style="background:var(--line)"></i>Daily close</span><span><i style="background:var(--ref);height:1px"></i>Average cost</span><span><i class="box" style="background:var(--loss);border-radius:50%"></i>Sell</span></div>
    <div class="multiples" id="priceCharts"></div>
  </section>

  <section class="card">
    <h2>Closed trades</h2>
    <p class="sub">Most recent last, matched first-in first-out</p>
    <div class="tablewrap" id="tradesTable"></div>
  </section>
</main>
<div class="tip" id="tip"></div>
<script>
const DATA = __DATA__;
const NS = "http://www.w3.org/2000/svg";
const tip = document.getElementById("tip");
const fmtMoney = v => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const fmtSigned = v => (v > 0 ? "+" : "") + fmtMoney(v);
const compact = v => { const a = Math.abs(v), s = v < 0 ? "-" : "";
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return s + "$" + (a / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return s + "$" + a.toFixed(a < 10 && a !== 0 ? 2 : 0); };
const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function niceTicks(min, max, n = 4) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out; }
function showTip(html, evt, host) { tip.innerHTML = html; tip.style.display = "block";
  const r = host.getBoundingClientRect(), tw = tip.offsetWidth;
  let x = evt.clientX + window.scrollX + 12; if (x + tw > window.scrollX + document.documentElement.clientWidth - 8) x = evt.clientX + window.scrollX - tw - 12;
  tip.style.left = x + "px"; tip.style.top = (evt.clientY + window.scrollY - 10) + "px"; }
function hideTip() { tip.style.display = "none"; }
function empty(host, msg) { host.innerHTML = '<div class="empty">' + msg + "</div>"; }
function table(host, cols, rows) {
  if (!rows.length) { host.innerHTML = '<div class="empty">No data yet</div>'; return; }
  host.innerHTML = "<table><thead><tr>" + cols.map(c => "<th>" + c[0] + "</th>").join("") + "</tr></thead><tbody>" +
    rows.map(r => "<tr>" + cols.map(c => "<td>" + c[1](r) + "</td>").join("") + "</tr>").join("") + "</tbody></table>"; }

/* Line chart: single series, optional area wash, optional reference line and markers. */
function lineChart(host, pts, opt = {}) {
  host.innerHTML = "";
  if (pts.length < 1) return empty(host, opt.emptyMsg || "No data yet");
  const W = host.clientWidth || 480, H = opt.height || 220, m = {t: 12, r: 16, b: 26, l: 52};
  const refs = opt.refSeries || [];
  const ys = pts.map(p => p.y).concat(opt.ref != null ? [opt.ref] : []).concat(opt.zero ? [0] : [])
    .concat(refs.filter(v => v != null));
  (opt.markers || []).forEach(k => ys.push(k.y));
  const ticks = niceTicks(Math.min(...ys), Math.max(...ys));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const X = i => m.l + (pts.length === 1 ? (W - m.l - m.r) / 2 : i * (W - m.l - m.r) / (pts.length - 1));
  const Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const svg = el("svg", {viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": opt.label || "line chart"}, host);
  ticks.forEach(t => { el("line", {x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: css(t === 0 && opt.zero ? "--axis" : "--grid"), "stroke-width": 1}, svg);
    el("text", {x: m.l - 8, y: Y(t) + 4, "text-anchor": "end"}, svg).textContent = compact(t); });
  const short = x => /^\d{4}-\d{2}-\d{2}/.test(x) ? x.slice(5, 10) : x;
  const minGap = 56, labelEvery = Math.max(1, Math.ceil(pts.length / Math.max(2, Math.floor((W - m.l - m.r) / 70))));
  pts.forEach((p, i) => { const isLast = i === pts.length - 1;
    if (!(i % labelEvery === 0 || isLast)) return;
    if (!isLast && pts.length > 1 && X(pts.length - 1) - X(i) < minGap) return;  // keep clear of the last label
    el("text", {x: X(i), y: H - 8, "text-anchor": i === 0 ? "start" : isLast ? "end" : "middle"}, svg).textContent = short(p.x); });
  if (opt.ref != null) { el("line", {x1: m.l, x2: W - m.r, y1: Y(opt.ref), y2: Y(opt.ref), stroke: css("--ref"), "stroke-width": 1}, svg);
    el("text", {x: m.l + 4, y: Y(opt.ref) - 4, "text-anchor": "start", class: "val"}, svg).textContent = "cost " + fmtMoney(opt.ref); }
  if (refs.length) {  // step line, e.g. average cost per day
    let path = "", prev = null;
    refs.forEach((v, i) => { if (v == null) { prev = null; return; }
      const x = X(i), y = Y(v);
      path += prev == null ? `M${x} ${y}` : `H${x}V${y}`; prev = v; });
    if (path) el("path", {d: path + `H${X(pts.length - 1)}`, fill: "none", stroke: css("--ref"), "stroke-width": 1}, svg);
    const firstIdx = refs.findIndex(v => v != null);
    if (firstIdx >= 0) el("text", {x: Math.max(m.l + 4, X(firstIdx)), y: Y(refs[firstIdx]) - 5, "text-anchor": "start", class: "val"}, svg).textContent = "avg cost";
  }
  const d = pts.map((p, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(p.y).toFixed(1)).join(" ");
  if (opt.area && pts.length > 1) { const base = Y(Math.max(y0, Math.min(0, y1)));
    el("path", {d: d + ` L${X(pts.length - 1)} ${base} L${X(0)} ${base} Z`, fill: css("--gain-wash")}, svg); }
  if (pts.length > 1) el("path", {d, fill: "none", stroke: css("--line"), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round"}, svg);
  const last = pts[pts.length - 1];
  el("circle", {cx: X(pts.length - 1), cy: Y(last.y), r: 4, fill: css("--line"), stroke: css("--surface-1"), "stroke-width": 2}, svg);
  el("text", {x: X(pts.length - 1) - 6, y: Y(last.y) - 9, "text-anchor": "end", class: "val"}, svg).textContent = (opt.fmt || fmtMoney)(last.y);
  (opt.markers || []).forEach(k => { const i = pts.findIndex(p => p.x === k.x); if (i < 0) return;
    el("circle", {cx: X(i), cy: Y(k.y), r: 5, fill: css("--loss"), stroke: css("--surface-1"), "stroke-width": 2}, svg); });
  const cross = el("line", {y1: m.t, y2: H - m.b, stroke: css("--axis"), "stroke-width": 1, visibility: "hidden"}, svg);
  const dot = el("circle", {r: 4, fill: css("--line"), stroke: css("--surface-1"), "stroke-width": 2, visibility: "hidden"}, svg);
  const hit = el("rect", {x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent"}, svg);
  hit.addEventListener("mousemove", e => { const r = svg.getBoundingClientRect(), sx = (e.clientX - r.left) * W / r.width;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round((sx - m.l) / ((W - m.l - m.r) / Math.max(1, pts.length - 1)))));
    const p = pts[i]; cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(p.y)); dot.setAttribute("visibility", "visible");
    showTip("<b>" + p.x + "</b><br>" + (opt.tipLabel || "Value") + ": " + (opt.fmt || fmtMoney)(p.y) + (p.extra || ""), e, host); });
  hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
}

/* Rounded data-end bar path, square at the baseline. */
function barPath(x, y, w, h, up, horizontal) {
  const r = Math.min(4, (horizontal ? h : w) / 2, Math.abs(horizontal ? w : h));
  if (!horizontal) {
    return up ? `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`
              : `M${x} ${y}V${y + h - r}Q${x} ${y + h} ${x + r} ${y + h}H${x + w - r}Q${x + w} ${y + h} ${x + w} ${y + h - r}V${y}Z`; }
  return up ? `M${x} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h - r}Q${x + w} ${y + h} ${x + w - r} ${y + h}H${x}Z`
            : `M${x + w} ${y}H${x + r}Q${x} ${y} ${x} ${y + r}V${y + h - r}Q${x} ${y + h} ${x + r} ${y + h}H${x + w}Z`;
}

/* Diverging column chart around zero. */
function columnChart(host, rows) {
  host.innerHTML = ""; if (!rows.length) return empty(host, "No closed trades yet");
  const W = host.clientWidth || 480, H = 220, m = {t: 18, r: 12, b: 26, l: 52};
  const ticks = niceTicks(Math.min(0, ...rows.map(r => r.value)), Math.max(0, ...rows.map(r => r.value)));
  const y0 = ticks[0], y1 = ticks[ticks.length - 1], Y = v => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const band = (W - m.l - m.r) / rows.length, bw = Math.max(2, Math.min(24, band - 2));
  const svg = el("svg", {viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "daily realized P&L"}, host);
  ticks.forEach(t => { el("line", {x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: css(t === 0 ? "--axis" : "--grid"), "stroke-width": 1}, svg);
    el("text", {x: m.l - 8, y: Y(t) + 4, "text-anchor": "end"}, svg).textContent = compact(t); });
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor((W - m.l - m.r) / 80))));
  let best = rows.reduce((a, b) => Math.abs(b.value) > Math.abs(a.value) ? b : a, rows[0]);
  rows.forEach((r, i) => { const x = m.l + i * band + (band - bw) / 2, up = r.value >= 0;
    const yv = Y(r.value), yz = Y(0), h = Math.max(1, Math.abs(yz - yv));
    el("path", {d: barPath(x, up ? yv : yz, bw, h, up, false), fill: css(up ? "--gain" : "--loss")}, svg);
    const lastX = m.l + (rows.length - 1) * band;
    if ((i % every === 0 && (i === rows.length - 1 || lastX - (m.l + i * band) >= 56)) || i === rows.length - 1)
      el("text", {x: x + bw / 2, y: H - 8, "text-anchor": i === rows.length - 1 ? "end" : "middle"}, svg).textContent = r.label.slice(5);
    if (r === best) el("text", {x: x + bw / 2, y: up ? yv - 5 : yv + 13, "text-anchor": "middle", class: "val"}, svg).textContent = fmtSigned(r.value);
    const hit = el("rect", {x: m.l + i * band, y: m.t, width: band, height: H - m.t - m.b, fill: "transparent"}, svg);
    hit.addEventListener("mousemove", e => showTip("<b>" + r.label + "</b><br>" + (up ? "Profit " : "Loss ") + fmtSigned(r.value) +
      (r.cum != null ? "<br>Cumulative " + fmtSigned(r.cum) : ""), e, host));
    hit.addEventListener("mouseleave", hideTip); });
}

/* Diverging horizontal bars, sorted. */
function hbarChart(host, rows) {
  host.innerHTML = ""; if (!rows.length) return empty(host, "No closed trades yet");
  rows = rows.slice().sort((a, b) => b.value - a.value);
  const W = host.clientWidth || 480, rowH = 28, m = {t: 8, r: 70, b: 22, l: 64}, H = m.t + m.b + rows.length * rowH;
  const ticks = niceTicks(Math.min(0, ...rows.map(r => r.value)), Math.max(0, ...rows.map(r => r.value)), 3);
  const x0 = ticks[0], x1 = ticks[ticks.length - 1], X = v => m.l + (v - x0) / (x1 - x0) * (W - m.l - m.r);
  const svg = el("svg", {viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "realized P&L by symbol"}, host);
  ticks.forEach(t => { el("line", {x1: X(t), x2: X(t), y1: m.t, y2: H - m.b, stroke: css(t === 0 ? "--axis" : "--grid"), "stroke-width": 1}, svg);
    el("text", {x: X(t), y: H - 6, "text-anchor": "middle"}, svg).textContent = compact(t); });
  rows.forEach((r, i) => { const y = m.t + i * rowH + (rowH - 16) / 2, up = r.value >= 0, xz = X(0), xv = X(r.value);
    el("path", {d: barPath(Math.min(xz, xv), y, Math.max(1, Math.abs(xv - xz)), 16, up, true), fill: css(up ? "--gain" : "--loss")}, svg);
    el("text", {x: m.l - 8, y: y + 12, "text-anchor": "end", class: "val"}, svg).textContent = r.label;
    el("text", {x: up ? xv + 6 : xz + 6, y: y + 12, "text-anchor": "start", class: "val"}, svg).textContent = fmtSigned(r.value);
    const hit = el("rect", {x: 0, y: m.t + i * rowH, width: W, height: rowH, fill: "transparent"}, svg);
    hit.addEventListener("mousemove", e => showTip("<b>" + r.label + "</b><br>Realized " + fmtSigned(r.value), e, host));
    hit.addEventListener("mouseleave", hideTip); });
}

function renderAll() {
  const s = DATA.summary;
  document.getElementById("meta").textContent = `${DATA.mode} · ${DATA.broker} · generated ${DATA.generated}`;
  document.getElementById("heroValue").textContent = fmtSigned(s.realized_net || 0);
  const tiles = [
    ["Realized profit", fmtMoney(s.realized_profit || 0), `${s.wins} winning trades`, "--gain"],
    ["Realized loss", fmtMoney(s.realized_loss || 0), `${s.losses} losing trades`, "--loss"],
    ["Win rate", s.win_rate == null ? "-" : (s.win_rate * 100).toFixed(0) + "%", `${s.closed_trades} closed trades`, null],
    ["Unrealized P&L", fmtSigned(DATA.unrealized || 0), `${DATA.positions.length} open positions`, (DATA.unrealized || 0) >= 0 ? "--gain" : "--loss"],
  ];
  document.getElementById("tiles").innerHTML = tiles.map(t => `<div class="tile"><div class="label">${t[3] ? `<span class="sign" style="background:var(${t[3]})"></span>` : ""}${t[0]}</div><div class="value">${t[1]}</div><div class="note">${t[2]}</div></div>`).join("");

  const days = DATA.by_day;
  lineChart(document.getElementById("cumChart"), days.map(d => ({x: d.date, y: d.cumulative})), {area: true, zero: true, tipLabel: "Cumulative", fmt: fmtSigned, emptyMsg: "No closed trades yet", label: "cumulative realized P&L"});
  table(document.getElementById("cumTable"), [["Date", r => r.date], ["Day P&L", r => fmtSigned(r.pnl)], ["Cumulative", r => fmtSigned(r.cumulative)]], days);
  columnChart(document.getElementById("dayChart"), days.map(d => ({label: d.date, value: d.pnl, cum: d.cumulative})));
  table(document.getElementById("dayTable"), [["Date", r => r.date], ["Realized P&L", r => fmtSigned(r.pnl)]], days);
  hbarChart(document.getElementById("symChart"), DATA.by_symbol);
  table(document.getElementById("symTable"), [["Symbol", r => r.label], ["Realized P&L", r => fmtSigned(r.value)]], DATA.by_symbol);
  lineChart(document.getElementById("eqChart"), DATA.equity, {tipLabel: "Equity", emptyMsg: "Run the monitor to record equity snapshots", label: "account equity"});
  table(document.getElementById("eqTable"), [["Date", r => r.x], ["Equity", r => fmtMoney(r.y)]], DATA.equity);

  const pc = document.getElementById("priceCharts"); pc.innerHTML = "";
  if (!DATA.prices.length) pc.innerHTML = '<div class="empty">No tracked prices yet - run <code>python -m trading_agent monitor --once</code></div>';
  DATA.prices.forEach(ps => {
    const box = document.createElement("div");
    const lastClose = ps.rows.length ? ps.rows[ps.rows.length - 1].close : null;
    const chg = ps.cost && lastClose ? (lastClose / ps.cost - 1) * 100 : null;
    box.innerHTML = `<h2>${ps.symbol}</h2><p class="sub">${ps.held ? "Held" : "Closed"} · cost ${ps.cost ? fmtMoney(ps.cost) : "-"}${chg != null ? " · " + (chg >= 0 ? "+" : "") + chg.toFixed(1) + "% vs cost" : ""}</p><div class="chart"></div><details><summary>Table view</summary><div class="tablewrap"></div></details>`;
    pc.appendChild(box);
    ps._box = box;
  });
  DATA.prices.forEach(ps => { const box = ps._box;
    const pts = ps.rows.map(r => ({x: r.date, y: r.close, extra: `<br>High ${fmtMoney(r.high)} · Low ${fmtMoney(r.low)}` +
      (r.cost != null ? `<br>Avg cost ${fmtMoney(r.cost)}` : "")}));
    const markers = ps.sells.map(sl => ({x: sl.date, y: sl.price}));
    lineChart(box.querySelector(".chart"), pts, {refSeries: ps.rows.map(r => r.cost), markers, height: 180, tipLabel: "Close", label: ps.symbol + " daily close"});
    table(box.querySelector(".tablewrap"), [["Date", r => r.date], ["Open", r => fmtMoney(r.open)], ["High", r => fmtMoney(r.high)], ["Low", r => fmtMoney(r.low)], ["Close", r => fmtMoney(r.close)], ["Avg cost", r => r.cost != null ? fmtMoney(r.cost) : "-"]], ps.rows);
  });
  table(document.getElementById("tradesTable"), [["Symbol", r => r.symbol], ["Closed", r => r.closed_at.slice(0, 10)], ["Side", r => r.direction],
    ["Qty", r => r.qty], ["Open", r => fmtMoney(r.open_price)], ["Close", r => fmtMoney(r.close_price)], ["P&L", r => fmtSigned(r.pnl)]], DATA.trades.slice().reverse());
}
document.getElementById("themeBtn").addEventListener("click", () => {
  const root = document.documentElement, cur = root.getAttribute("data-theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.setAttribute("data-theme", cur === "dark" ? "light" : "dark"); renderAll(); });
let rt; window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderAll, 120); });
renderAll();
</script>
</body>
</html>
"""
