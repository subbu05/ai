"use strict";
/* Trading watchlist UI. Talks only to this local server; every call carries the session token. */

const TOKEN = (() => {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m) {
    try { sessionStorage.setItem("ta_token", m[1]); } catch (e) { /* storage blocked */ }
    history.replaceState(null, "", location.pathname);  // keep the token out of the address bar
    return m[1];
  }
  try { return sessionStorage.getItem("ta_token") || ""; } catch (e) { return ""; }
})();

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const money = v => v == null || isNaN(v) ? "-" : (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const signed = v => v == null ? "-" : (v > 0 ? "+" : "") + money(v);
const r2 = v => Math.round(v * 100) / 100;
const pct = v => v == null || isNaN(v) ? "-" : (r2(v) > 0 ? "+" : "") + (r2(v) === 0 ? 0 : r2(v)).toFixed(2) + "%";
const dirClass = v => v == null || r2(v) === 0 ? "" : v > 0 ? "pos" : "neg";

const prefs = (() => {
  const defaults = {group: "label", labels: [], held: false, monitored: false, profit: false, search: ""};
  try { return Object.assign(defaults, JSON.parse(localStorage.getItem("ta_prefs") || "{}")); } catch (e) { return defaults; }
})();
const savePrefs = () => { try { localStorage.setItem("ta_prefs", JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

let STATE = null;
let trade = {symbol: null, side: "buy", amt: "qty", previewed: null};

async function api(method, path, body) {
  const opts = {method, headers: {"X-Auth-Token": TOKEN}};
  if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch("/api/" + path, opts);
  const data = await r.json().catch(() => ({error: r.statusText}));
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
}

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.hidden = true; }, 4000);
}

/* ------------------------------------------------------------------ rendering */
function renderTop() {
  const s = STATE, a = s.account;
  const badge = $("#modeBadge");
  badge.textContent = s.live ? "Live" : s.mode.replace("alpaca-", "alpaca ");
  badge.classList.toggle("live", s.live);
  $("#stats").innerHTML = [
    ["Equity", money(a.equity)], ["Cash", money(a.cash)], ["Buying power", money(a.buying_power)],
    ["Day P&L", signed(a.day_pl)], ["Realized P&L", signed(s.realized.realized_net)],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("");
  const banner = $("#banner");
  if (s.kill_switch) { banner.hidden = false; banner.textContent = "Kill switch is engaged: all trading is blocked. Run `python -m trading_agent resume` to lift it."; }
  else if (s.live) { banner.hidden = false; banner.textContent = "LIVE account: orders placed here use real money."; }
  else banner.hidden = true;

  const m = s.monitor;
  $("#monToggle").checked = m.running;
  $("#monToggleLabel").textContent = m.running ? "On" : "Off";
  $("#monDesc").textContent = m.enabled
    ? `Sells the whole position of a monitored holding once it has been ${(m.min_profit_pct * 100).toFixed(0)}%+ in profit and drops ` +
      `${(m.drop_pct * 100).toFixed(0)}% from ${m.reference === "peak" ? "its peak" : "today's high"}; never below cost. ` +
      `${m.auto_sell ? "Sells automatically." : "Live account: suggests sells, you confirm."} ` +
      `Checks every ${Math.round(m.interval / 60)} min.` + (m.last_check ? ` Last check ${m.last_check}.` : "")
    : "Disabled in config/risk.toml ([profit_protect] enabled = false).";
}

function protectionCell(it) {
  if (!it.monitor) return `<span class="status off">Not monitored</span>`;
  if (!it.position) return `<span class="status off">Watching</span>`;
  const p = it.protection;
  if (!p) return `<span class="status off">Not checked yet</span>`;
  if (p.action === "sell_now" || p.action === "sell_at_cost")
    return `<span class="status sell">${p.action === "sell_now" ? "Sell triggered" : "Break-even sell"}${p.result ? " · " + esc(p.result) : ""}</span>`;
  if (p.trigger) return `<span class="status armed">Armed · sells &le; ${money(p.trigger)}</span>`;
  return `<span class="status off">Not in profit yet</span>`;
}

function rowHtml(it) {
  const q = it.quote || {}, pos = it.position, day = it.day;
  const last = q.last;
  const dayChg = day && day.open ? (last / day.open - 1) * 100 : null;
  const labels = it.labels.map(l => `<span class="chip">${esc(l)}</span>`).join("") +
    `<button type="button" class="chip add" data-act="labels" data-sym="${it.symbol}" aria-label="Edit labels for ${it.symbol}">+ label</button>`;
  return `<tr>
    <td class="l"><button type="button" class="ticker" data-act="trade" data-sym="${it.symbol}" title="Trade ${it.symbol}">${it.symbol}</button>${it.etf ? ' <span class="muted small">ETF</span>' : ""}</td>
    <td class="l"><div class="labels">${labels}</div></td>
    <td>${q.error ? '<span class="muted">n/a</span>' : money(last)}</td>
    <td class="${dirClass(dayChg)} hide-sm">${pct(dayChg)}</td>
    <td>${pos ? pos.qty : '<span class="muted">-</span>'}</td>
    <td class="hide-sm">${pos ? money(pos.avg_cost) : '<span class="muted">-</span>'}</td>
    <td class="${pos ? dirClass(pos.unrealized_pl) : ""}">${pos ? signed(pos.unrealized_pl) + ` <span class="muted small">${pct(pos.unrealized_pct)}</span>` : '<span class="muted">-</span>'}</td>
    <td class="l">${protectionCell(it)}</td>
    <td><label class="check"><input type="checkbox" data-act="monitor" data-sym="${it.symbol}" ${it.monitor ? "checked" : ""} aria-label="Monitor ${it.symbol}"></label></td>
    <td class="actions"><button type="button" class="danger" data-act="remove" data-sym="${it.symbol}" aria-label="Remove ${it.symbol}">Remove</button></td>
  </tr>`;
}

function tableHtml(items) {
  if (!items.length) return `<div class="empty">No tickers match.</div>`;
  return `<div class="tablewrap"><table>
    <thead><tr><th class="l">Ticker</th><th class="l">Labels</th><th>Last</th><th class="hide-sm">Today</th><th>Qty</th>
    <th class="hide-sm">Avg cost</th><th>Unrealized</th><th class="l">Profit protection</th><th>Monitor</th><th></th></tr></thead>
    <tbody>${items.map(rowHtml).join("")}</tbody></table></div>`;
}

function filteredItems() {
  const text = prefs.search.trim().toUpperCase();
  return STATE.watchlist.items.filter(it => {
    if (text && !it.symbol.includes(text) && !(it.note || "").toUpperCase().includes(text)) return false;
    if (prefs.labels.length && !prefs.labels.some(l => it.labels.includes(l))) return false;
    if (prefs.held && !it.position) return false;
    if (prefs.monitored && !it.monitor) return false;
    if (prefs.profit && !(it.position && it.position.unrealized_pl > 0)) return false;
    return true;
  }).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

function renderLabelFilter() {
  const labels = STATE.watchlist.labels;
  prefs.labels = prefs.labels.filter(l => labels.includes(l));
  const box = $("#labelFilter");
  if (!labels.length) { box.innerHTML = `<span class="muted small">Add labels to tickers to filter and group them.</span>`; return; }
  box.innerHTML = `<span class="muted small">Filter:</span>` + labels.map(l =>
    `<button type="button" class="chip" data-filter="${esc(l)}" aria-pressed="${prefs.labels.includes(l)}">${esc(l)}</button>`).join("") +
    (prefs.labels.length ? ` <button type="button" class="ghost small" id="clearFilter">Clear</button>` : "");
}

function renderGroups() {
  const items = filteredItems();
  const host = $("#groups");
  if (!STATE.watchlist.items.length) { host.innerHTML = `<div class="empty">Your watchlist is empty. Add a ticker above.</div>`; return; }
  if (prefs.group === "none") { host.innerHTML = tableHtml(items); return; }
  const groups = new Map();
  STATE.watchlist.labels.forEach(l => groups.set(l, []));
  const unlabeled = [];
  items.forEach(it => { if (!it.labels.length) unlabeled.push(it); it.labels.forEach(l => { if (!groups.has(l)) groups.set(l, []); groups.get(l).push(it); }); });
  if (unlabeled.length) groups.set("Unlabeled", unlabeled);
  const shown = [...groups.entries()].filter(([l, v]) => v.length && (!prefs.labels.length || prefs.labels.includes(l) || l === "Unlabeled"));
  host.innerHTML = shown.length ? shown.map(([label, list]) => {
    const pl = list.reduce((s, it) => s + (it.position ? it.position.unrealized_pl : 0), 0);
    const held = list.filter(it => it.position).length;
    return `<section class="group"><h3>${esc(label)} <span class="muted small">${list.length} ticker${list.length === 1 ? "" : "s"} · ${held} held${held ? " · unrealized " + signed(pl) : ""}</span></h3>${tableHtml(list)}</section>`;
  }).join("") : `<div class="empty">No tickers match.</div>`;
}

function renderOrders() {
  const orders = STATE.open_orders;
  $("#ordersTable").innerHTML = orders.length ? `<table><thead><tr><th class="l">Symbol</th><th class="l">Side</th><th>Qty</th><th class="l">Type</th><th>Limit / stop</th><th class="l">Reason</th><th></th></tr></thead><tbody>` +
    orders.map(o => `<tr><td class="l">${esc(o.symbol)}</td><td class="l">${o.side}</td><td>${o.qty}</td><td class="l">${o.order_type}</td>
      <td>${o.limit_price ? money(o.limit_price) : o.stop_price ? money(o.stop_price) : "-"}</td><td class="l small">${esc((o.reason || "").slice(0, 60))}</td>
      <td class="actions"><button type="button" class="danger" data-act="cancel" data-id="${esc(o.id)}">Cancel</button></td></tr>`).join("") + "</tbody></table>"
    : `<div class="empty">No open orders.</div>`;
  const other = STATE.unwatched_positions;
  $("#otherPanel").hidden = !other.length;
  $("#otherTable").innerHTML = other.length ? `<table><thead><tr><th class="l">Symbol</th><th>Qty</th><th>Avg cost</th><th>Unrealized</th><th></th></tr></thead><tbody>` +
    other.map(p => `<tr><td class="l"><button type="button" class="ticker" data-act="trade" data-sym="${esc(p.symbol)}">${esc(p.symbol)}</button></td><td>${p.qty}</td>
      <td>${money(p.avg_entry_price)}</td><td class="${dirClass(p.unrealized_pl)}">${signed(p.unrealized_pl)}</td>
      <td class="actions">${p.asset_class === "option" ? "" : `<button type="button" class="secondary" data-act="watch" data-sym="${esc(p.symbol)}">Add to watchlist</button>`}</td></tr>`).join("") + "</tbody></table>" : "";
  $("#labelOptions").innerHTML = STATE.watchlist.labels.map(l => `<option value="${esc(l)}">`).join("");
}

function renderCheck(check) {
  if (!check || !check.decisions) return;
  $("#checkPanel").hidden = false;
  $("#checkAt").textContent = (check.at || "") + (check.dry_run ? " · preview, nothing sold" : "");
  $("#checkTable").innerHTML = `<table><thead><tr><th class="l">Symbol</th><th class="l">Action</th><th>Price</th><th>Cost</th><th>Trigger</th><th class="l">Detail</th></tr></thead><tbody>` +
    check.decisions.map(d => `<tr><td class="l">${esc(d.symbol)}</td><td class="l">${esc(d.action)}${d.result ? " · " + esc(d.result) : ""}</td>
      <td>${money(d.price)}</td><td>${d.avg_cost ? money(d.avg_cost) : "-"}</td><td>${d.trigger ? money(d.trigger) : "-"}</td><td class="l small">${esc(d.reason)}</td></tr>`).join("") + "</tbody></table>";
}

function renderAll() {
  if (!STATE) return;
  renderTop(); renderLabelFilter(); renderGroups(); renderOrders();
  document.querySelectorAll("[data-group]").forEach(b => b.classList.toggle("on", b.dataset.group === prefs.group));
  $("#fHeld").checked = prefs.held; $("#fMonitored").checked = prefs.monitored; $("#fProfit").checked = prefs.profit;
  if (document.activeElement !== $("#search")) $("#search").value = prefs.search;
  if (trade.symbol && !$("#drawer").hidden) renderDrawerInfo();
}

async function refresh() {
  try { STATE = await api("GET", "state"); renderAll(); }
  catch (e) { toast(e.message.includes("token") ? "Not authorized: open the link printed by `python -m trading_agent ui`." : "Refresh failed: " + e.message); }
}

/* ------------------------------------------------------------------ trade drawer */
function findItem(sym) {
  return STATE.watchlist.items.find(i => i.symbol === sym) ||
    (() => { const p = STATE.unwatched_positions.find(p => p.symbol === sym);
      return p ? {symbol: sym, quote: {}, position: {qty: p.qty, avg_cost: p.avg_entry_price, unrealized_pl: p.unrealized_pl, unrealized_pct: null}} : {symbol: sym, quote: {}}; })();
}

function renderDrawerInfo() {
  const it = findItem(trade.symbol), q = it.quote || {}, pos = it.position;
  $("#dTitle").textContent = trade.symbol;
  $("#dSub").textContent = (it.labels && it.labels.length ? it.labels.join(" · ") : "No labels") + (it.etf ? " · ETF" : "");
  if (q.last != null) $("#dQuote").innerHTML = [["Bid", q.bid], ["Ask", q.ask], ["Last", q.last]].map(([k, v]) => `<div><dt>${k}</dt><dd>${money(v)}</dd></div>`).join("");
  $("#dPos").innerHTML = pos ? `You hold <b>${pos.qty}</b> at ${money(pos.avg_cost)} · unrealized <span class="${dirClass(pos.unrealized_pl)}">${signed(pos.unrealized_pl)}</span>` : "You don't hold this.";
  $("#sellAllWrap").hidden = !(trade.side === "sell" && pos);
}

async function openDrawer(sym) {
  trade = {symbol: sym, side: "buy", amt: "qty", previewed: null};
  $("#orderForm").reset();
  setSeg("side", "buy"); setSeg("amt", "qty"); $("#limitWrap").hidden = true;
  $("#preview").hidden = true; $("#confirmBtn").disabled = true; $("#confirmBtn").textContent = "Confirm";
  $("#liveWrap").hidden = !STATE.live;
  $("#dQuote").innerHTML = ""; $("#dSpark").innerHTML = ""; $("#dInd").textContent = "";
  renderDrawerInfo();
  $("#scrim").hidden = false; $("#drawer").hidden = false;
  $("#amount").focus();
  try {
    const h = await api("GET", "history/" + encodeURIComponent(sym) + "?days=90");
    if (trade.symbol !== sym) return;
    $("#dQuote").innerHTML = [["Bid", h.quote.bid], ["Ask", h.quote.ask], ["Last", h.quote.last]].map(([k, v]) => `<div><dt>${k}</dt><dd>${money(v)}</dd></div>`).join("");
    sparkline($("#dSpark"), h.closes);
    const ind = h.indicators;
    $("#dInd").textContent = `90-day: ${ind.trend ? "trend " + ind.trend + " · " : ""}RSI ${ind.rsi14 ?? "-"} · 20d momentum ${ind.mom_20d != null ? (ind.mom_20d * 100).toFixed(1) + "%" : "-"} · vol ${ind.vol20_annualized != null ? (ind.vol20_annualized * 100).toFixed(0) + "%" : "-"}`;
  } catch (e) { $("#dInd").textContent = "No price history: " + e.message; }
}

function closeDrawer() { $("#drawer").hidden = true; $("#scrim").hidden = true; trade.symbol = null; }

function sparkline(host, closes) {
  if (!closes || closes.length < 2) { host.innerHTML = ""; return; }
  const W = host.clientWidth || 400, H = 90, m = {t: 8, r: 46, b: 8, l: 4};
  const lo = Math.min(...closes), hi = Math.max(...closes), span = hi - lo || 1;
  const X = i => m.l + i * (W - m.l - m.r) / (closes.length - 1), Y = v => m.t + (1 - (v - lo) / span) * (H - m.t - m.b);
  const d = closes.map((c, i) => (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(c).toFixed(1)).join(" ");
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const last = closes[closes.length - 1];
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}">
    <path d="${d} L${X(closes.length - 1)} ${H - m.b} L${X(0)} ${H - m.b} Z" fill="${css("--accent-wash")}"/>
    <path d="${d}" fill="none" stroke="${css("--accent")}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${X(closes.length - 1)}" cy="${Y(last)}" r="4" fill="${css("--accent")}" stroke="${css("--surface")}" stroke-width="2"/>
    <text x="${W - m.r + 6}" y="${Y(hi) + 4}">${money(hi)}</text><text x="${W - m.r + 6}" y="${Y(lo)}">${money(lo)}</text></svg>`;
}

function setSeg(kind, value) {
  document.querySelectorAll(`[data-${kind}]`).forEach(b => b.classList.toggle("on", b.dataset[kind] === value));
}

function orderBody() {
  const body = {symbol: trade.symbol, side: trade.side, order_type: $("#orderType").value, reason: $("#reason").value.trim()};
  if (trade.side === "sell" && $("#sellAll").checked) body.sell_all = true;
  else body[trade.amt] = $("#amount").value.trim();
  if (body.order_type === "limit") body.limit_price = $("#limitPrice").value.trim();
  return body;
}

function invalidatePreview() { trade.previewed = null; $("#confirmBtn").disabled = true; $("#confirmBtn").textContent = "Confirm"; }

async function doPreview(ev) {
  ev.preventDefault();
  const body = orderBody();
  try {
    const r = await api("POST", "order/preview", body);
    const box = $("#preview"); box.hidden = false;
    if (r.status === "invalid") { box.className = "preview bad"; box.innerHTML = `<div class="title bad">${esc(r.error)}</div>`; invalidatePreview(); return; }
    const risk = r.risk, ok = risk.approved, o = r.order;
    box.className = "preview " + (ok ? "ok" : "bad");
    box.innerHTML = `<div class="title ${ok ? "ok" : "bad"}">${ok ? "Passes risk checks" : "Blocked by risk checks"}</div>
      <div>${o.side.toUpperCase()} ${o.qty} ${esc(o.symbol)} · ${o.order_type}${o.limit_price ? " @ " + money(o.limit_price) : ""} · est. ${money(risk.est_notional)}</div>
      ${risk.reasons.length ? "<ul>" + risk.reasons.map(x => `<li>${esc(x)}</li>`).join("") + "</ul>" : ""}
      ${risk.warnings.length ? "<ul>" + risk.warnings.map(x => `<li>${esc(x)}</li>`).join("") + "</ul>" : ""}`;
    trade.previewed = ok ? JSON.stringify(body) : null;
    $("#confirmBtn").disabled = !ok;
    $("#confirmBtn").textContent = ok ? `Confirm ${o.side} ${o.qty} ${o.symbol}` : "Confirm";
  } catch (e) { toast(e.message); }
}

async function doConfirm() {
  const body = orderBody();
  if (JSON.stringify(body) !== trade.previewed) { invalidatePreview(); toast("Order changed - preview it again."); return; }
  if (STATE.live && !$("#liveAck").checked) { toast("Tick 'I understand this uses real money' first."); return; }
  $("#confirmBtn").disabled = true;
  try {
    const r = await api("POST", "order", Object.assign(body, {confirm: true, confirm_live: STATE.live ? $("#liveAck").checked : undefined}));
    const o = r.order || {};
    toast(r.status === "filled" ? `Filled: ${o.side} ${o.filled_qty} ${o.symbol} @ ${money(o.filled_avg_price)}`
      : r.status === "new" ? `Order working: ${o.side} ${o.qty} ${o.symbol}` : `Order ${r.status}${r.error ? ": " + r.error : ""}`);
    closeDrawer(); await refresh();
  } catch (e) { toast(e.message); $("#confirmBtn").disabled = false; }
}

/* ------------------------------------------------------------------ labels dialog */
let labelTarget = null;  // symbol, or null = manage all labels
function openLabels(sym) {
  labelTarget = sym;
  const dlg = $("#labelDialog"), body = $("#ldBody");
  $("#ldNew").value = "";
  if (sym) {
    const it = findItem(sym);
    $("#ldTitle").textContent = `Labels for ${sym}`;
    body.innerHTML = STATE.watchlist.labels.length ? STATE.watchlist.labels.map(l =>
      `<label class="check"><input type="checkbox" value="${esc(l)}" ${it.labels.includes(l) ? "checked" : ""}> ${esc(l)}</label>`).join("")
      : `<span class="muted small">No labels yet - create one below.</span>`;
  } else {
    $("#ldTitle").textContent = "Manage labels";
    body.innerHTML = STATE.watchlist.labels.length ? STATE.watchlist.labels.map(l =>
      `<div class="lrow"><input type="text" value="${esc(l)}" data-old="${esc(l)}" aria-label="Rename ${esc(l)}" maxlength="32">
        <button type="button" class="danger" data-del="${esc(l)}">Delete</button></div>`).join("")
      : `<span class="muted small">No labels yet.</span>`;
  }
  dlg.showModal();
}

async function saveLabels() {
  const newLabel = $("#ldNew").value.trim();
  try {
    if (labelTarget) {
      const labels = [...$("#ldBody").querySelectorAll("input[type=checkbox]:checked")].map(i => i.value);
      if (newLabel) labels.push(newLabel);
      await api("PATCH", "watchlist/" + encodeURIComponent(labelTarget), {labels});
    } else {
      for (const inp of $("#ldBody").querySelectorAll("input[data-old]")) {
        if (inp.value.trim() && inp.value.trim() !== inp.dataset.old) await api("PATCH", "labels", {old: inp.dataset.old, new: inp.value.trim()});
      }
      if (newLabel) await api("POST", "labels", {name: newLabel});
    }
    await refresh();
  } catch (e) { toast(e.message); }
}

/* ------------------------------------------------------------------ events */
document.addEventListener("click", async ev => {
  const t = ev.target.closest("[data-act], [data-filter], [data-group], [data-side], [data-amt], [data-del], #clearFilter");
  if (!t) return;
  if (t.id === "clearFilter") { prefs.labels = []; savePrefs(); renderAll(); return; }
  if (t.dataset.filter !== undefined) {
    const l = t.dataset.filter; prefs.labels = prefs.labels.includes(l) ? prefs.labels.filter(x => x !== l) : [...prefs.labels, l];
    savePrefs(); renderAll(); return;
  }
  if (t.dataset.group) { prefs.group = t.dataset.group; savePrefs(); renderAll(); return; }
  if (t.dataset.side) { trade.side = t.dataset.side; setSeg("side", trade.side); renderDrawerInfo(); invalidatePreview(); return; }
  if (t.dataset.amt) { trade.amt = t.dataset.amt; setSeg("amt", trade.amt); $("#amtLabel").textContent = trade.amt === "qty" ? "Shares" : "Dollars"; invalidatePreview(); return; }
  if (t.dataset.del) {
    if (!confirm(`Delete label "${t.dataset.del}"? It will be removed from every ticker.`)) return;
    try { await api("DELETE", "labels/" + encodeURIComponent(t.dataset.del)); $("#labelDialog").close(); await refresh(); } catch (e) { toast(e.message); }
    return;
  }
  const sym = t.dataset.sym;
  try {
    switch (t.dataset.act) {
      case "trade": await openDrawer(sym); break;
      case "labels": openLabels(sym); break;
      case "remove":
        if (confirm(`Remove ${sym} from the watchlist? (Positions are not sold.)`)) { await api("DELETE", "watchlist/" + encodeURIComponent(sym)); toast(`${sym} removed`); await refresh(); }
        break;
      case "watch": await api("POST", "watchlist", {symbol: sym, labels: [], monitor: true}); await refresh(); break;
      case "cancel": await api("POST", "orders/" + encodeURIComponent(t.dataset.id) + "/cancel"); toast("Order canceled"); await refresh(); break;
    }
  } catch (e) { toast(e.message); }
});

document.addEventListener("change", async ev => {
  const t = ev.target;
  if (t.dataset && t.dataset.act === "monitor") {
    try { await api("PATCH", "watchlist/" + encodeURIComponent(t.dataset.sym), {monitor: t.checked}); await refresh(); } catch (e) { toast(e.message); t.checked = !t.checked; }
  }
});

$("#addForm").addEventListener("submit", async ev => {
  ev.preventDefault();
  const symbol = $("#addSymbol").value.trim().toUpperCase();
  const labels = $("#addLabels").value.split(",").map(s => s.trim()).filter(Boolean);
  try {
    await api("POST", "watchlist", {symbol, labels, monitor: $("#addMonitor").checked});
    $("#addSymbol").value = ""; toast(`${symbol} added`); await refresh(); $("#addSymbol").focus();
  } catch (e) { toast(e.message); }
});

$("#search").addEventListener("input", e => { prefs.search = e.target.value; savePrefs(); renderGroups(); });
[["#fHeld", "held"], ["#fMonitored", "monitored"], ["#fProfit", "profit"]].forEach(([sel, key]) =>
  $(sel).addEventListener("change", e => { prefs[key] = e.target.checked; savePrefs(); renderGroups(); }));
$("#manageLabels").addEventListener("click", () => openLabels(null));
$("#labelDialogForm").addEventListener("submit", ev => { if (ev.submitter && ev.submitter.value === "save") saveLabels(); });

$("#monToggle").addEventListener("change", async e => {
  try { await api("POST", "monitor/toggle", {running: e.target.checked}); toast(e.target.checked ? "Profit protection on" : "Profit protection off"); await refresh(); }
  catch (err) { toast(err.message); e.target.checked = !e.target.checked; }
});
for (const [id, dry] of [["#monPreview", true], ["#monRun", false]]) {
  $(id).addEventListener("click", async () => {
    if (!dry && STATE.live && !confirm("Run the profit-protection check on your LIVE account now?")) return;
    try { const r = await api("POST", "monitor/run", {dry_run: dry}); renderCheck(r); await refresh(); toast(dry ? "Preview done - nothing was sold" : "Check complete"); }
    catch (e) { toast(e.message); }
  });
}

$("#orderForm").addEventListener("submit", doPreview);
$("#confirmBtn").addEventListener("click", doConfirm);
$("#orderForm").addEventListener("input", e => { if (e.target.id !== "liveAck") invalidatePreview(); });
$("#orderType").addEventListener("change", e => { $("#limitWrap").hidden = e.target.value !== "limit"; invalidatePreview(); });
$("#sellAll").addEventListener("change", e => { $("#amount").disabled = e.target.checked; });
$("#dClose").addEventListener("click", closeDrawer);
$("#scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#drawer").hidden) closeDrawer(); });

$("#themeBtn").addEventListener("click", () => {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  root.setAttribute("data-theme", cur === "dark" ? "light" : "dark");
  try { localStorage.setItem("ta_theme", root.getAttribute("data-theme")); } catch (e) { /* ignore */ }
});
try { const th = localStorage.getItem("ta_theme"); if (th) document.documentElement.setAttribute("data-theme", th); } catch (e) { /* ignore */ }

refresh();
setInterval(() => { if (!document.hidden) refresh(); }, 5000);
