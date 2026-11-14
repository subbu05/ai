import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WebSocket } from "ws";

import { ROOT, dataDir, saveLocalSettings, saveCredentials, credentialStatus, type AppSettings, type BrokerId } from "./config.js";
import { Storage } from "./storage.js";
import { QuoteHub } from "./market/quoteHub.js";
import { createMarketData } from "./market/index.js";
import { lookup } from "./market/catalog.js";
import type { MarketDataProvider } from "./market/provider.js";
import { OptionsAwareProvider } from "./options/provider.js";
import { SimulatedOptionModel, listExpirations, strikesAround } from "./options/chain.js";
import { CONTRACT_MULTIPLIER, formatOcc, isOption, nyDate } from "./options/occ.js";
import { BrokerManager } from "./brokers/manager.js";
import { BROKERS } from "./brokers/index.js";
import { PaperBroker } from "./brokers/paper.js";
import { WidgetStore } from "./widgets.js";
import { realizedBySymbol } from "./pnl.js";
import { TaxBook } from "./tax/report.js";
import { loadTaxRules, type TaxRules } from "./tax/rules.js";
import { ProfitGuard } from "./protect.js";
import { killSwitch } from "./killSwitch.js";
import { HttpError, normalizeSymbol } from "./util.js";
import type { Quote, OrderRequest } from "./types.js";

export interface AppContext {
  app: FastifyInstance;
  hub: QuoteHub;
  brokers: BrokerManager;
  widgets: WidgetStore;
  storage: Storage;
  close: () => Promise<void>;
}

const MAX_WS_BUFFER = 1 << 20; // 1 MiB: beyond this a client is "slow"; we skip deltas and resync later

/**
 * Compact wire format for quotes: [symbol, last, bid, ask, prevClose, high, low, volume, ts]
 * Options append: iv, delta, gamma, theta, vega, rho, openInterest, underlyingPrice.
 */
const rnd = (n: number, dp: number) => Number(n.toFixed(dp));
const encodeQuote = (q: Quote): string => {
  const base = `[${JSON.stringify(q.symbol)},${q.last},${q.bid},${q.ask},${q.prevClose},${q.high},${q.low},${q.volume},${q.ts}`;
  const g = q.greeks;
  if (!g) return base + "]";
  return `${base},${rnd(g.iv, 4)},${rnd(g.delta, 4)},${rnd(g.gamma, 5)},${rnd(g.theta, 4)},${rnd(g.vega, 4)},${rnd(g.rho, 4)},${q.oi ?? 0},${q.underlyingPrice ?? 0}]`;
};

interface Client {
  socket: WebSocket;
  subs: Set<string>;
  needsResync: boolean;
}

export async function buildApp(settings: AppSettings, opts: { provider?: MarketDataProvider; logger?: boolean; persistSettings?: boolean; taxRules?: TaxRules } = {}): Promise<AppContext> {
  const storage = new Storage(dataDir(settings));
  const persist = (patch: Partial<AppSettings>) => { if (opts.persistSettings !== false) saveLocalSettings(patch); };
  const optionModel = new SimulatedOptionModel(settings.options?.riskFreeRate ?? 0.045);
  const provider = new OptionsAwareProvider(opts.provider ?? createMarketData(settings), optionModel);
  const hub = new QuoteHub(provider, settings.marketData.flushMs);
  const widgets = new WidgetStore(storage);
  const brokers = new BrokerManager({ storage, hub, startingCash: settings.paper.startingCash });
  const clients = new Set<Client>();
  let clientSeq = 0;

  const app = Fastify({ logger: opts.logger ? { level: "info" } : false, bodyLimit: 256 * 1024 });

  // ---------------------------------------------------------------- request guard
  // Only this dashboard's own page may talk to the server:
  // - Host must be localhost (blocks DNS rebinding) while bound to loopback;
  // - Origin, when sent, must match the Host (blocks other websites, incl. WebSocket hijacking);
  // - browsers' Sec-Fetch-Site must not be "cross-site" (defence in depth for old/odd clients).
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"].includes(settings.host);
  const hostOk = (h: string | undefined) => !!h && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(h);
  app.addHook("onRequest", async (req, reply) => {
    const host = req.headers.host;
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const originHost = origin?.replace(/^https?:\/\//i, "");
    const bad =
      (loopback && !hostOk(host)) ||
      (origin !== undefined && (!/^https?:\/\//i.test(origin) || originHost?.toLowerCase() !== host?.toLowerCase())) ||
      site === "cross-site";
    if (bad) return reply.code(403).send({ error: "Forbidden: requests from other sites are not allowed" });
  });

  // Browser hardening for every response.
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; " +
      "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    reply.header("X-Frame-Options", "DENY"); // no clickjacking of Buy/Sell buttons
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const code = err instanceof HttpError ? err.statusCode : err.statusCode ?? 500;
    if (code >= 500 && code !== 501) app.log.error(err);
    reply.code(code).send({ error: err.message });
  });

  // ---------------------------------------------------------------- demand wiring
  const syncWidgetDemand = () => hub.setDemand("widgets", widgets.allSymbols());
  widgets.onChange(syncWidgetDemand);
  syncWidgetDemand();

  const broadcast = (msg: string) => {
    for (const c of clients) if (c.socket.readyState === 1) c.socket.send(msg);
  };

  const guard = new ProfitGuard(storage, hub, () => settings.profitGuard, (b) => !b.live || settings.liveTradingEnabled);
  guard.onEvent((e) => {
    if (e.action !== "sell") app.log.warn(e.message);
    broadcast(JSON.stringify({ t: "guard", d: e }));
  });
  const refreshGuard = (b: Parameters<typeof guard.refresh>[0]) => guard.refresh(b).catch((err) => app.log.error(err));

  brokers.attach((b) => {
    hub.setDemand("broker", b.watchedSymbols());
    void refreshGuard(b);
    return [
      b.on("order", (o) => {
        hub.setDemand("broker", b.watchedSymbols());
        broadcast(JSON.stringify({ t: "order", d: o }));
      }),
      b.on("portfolio", async () => {
        hub.setDemand("broker", b.watchedSymbols());
        await refreshGuard(b);
        try {
          const [account, positions] = await Promise.all([b.account(), b.positions()]);
          broadcast(JSON.stringify({ t: "pf", d: { account, positions } }));
        } catch (err) {
          app.log.error(err);
        }
      }),
    ];
  });
  brokers.onSwitch((b) => broadcast(JSON.stringify({ t: "broker", d: { id: b.id, name: b.displayName, live: b.live } })));

  try {
    await brokers.use(settings.broker);
  } catch (err) {
    console.error(`Could not start broker "${settings.broker}": ${(err as Error).message}. Falling back to paper.`);
    await brokers.use("paper");
  }

  // ---------------------------------------------------------------- quote fan-out
  hub.onFlush((batch) => {
    if (clients.size === 0) return;
    // Encode each changed quote once, then assemble per-client frames from the fragments.
    const frag = new Map<string, string>();
    for (const q of batch) frag.set(q.symbol, encodeQuote(q));
    for (const c of clients) {
      if (c.socket.readyState !== 1) continue;
      if (c.socket.bufferedAmount > MAX_WS_BUFFER) {
        c.needsResync = true;
        continue;
      }
      let parts: string[];
      if (c.needsResync) {
        c.needsResync = false;
        parts = [...c.subs].map((s) => hub.get(s)).filter((q): q is Quote => !!q).map(encodeQuote);
      } else {
        parts = [];
        for (const s of c.subs) {
          const f = frag.get(s);
          if (f) parts.push(f);
        }
      }
      if (parts.length) c.socket.send(`{"t":"q","d":[${parts.join(",")}]}`);
    }
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024, perMessageDeflate: false } });

  app.get("/ws", { websocket: true }, (socket: WebSocket) => {
    const id = `client:${++clientSeq}`;
    const client: Client = { socket, subs: new Set(), needsResync: false };
    clients.add(client);
    const b = brokers.broker;
    socket.send(JSON.stringify({ t: "hello", d: { provider: hub.providerName, broker: { id: b.id, name: b.displayName, live: b.live } } }));

    socket.on("message", async (raw) => {
      let msg: { t?: string; symbols?: unknown };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.t === "sub" && Array.isArray(msg.symbols)) {
        const syms = msg.symbols.slice(0, 1000).map(normalizeSymbol).filter((s): s is string => !!s);
        client.subs = new Set(syms);
        hub.setDemand(id, syms);
        // Immediately send a snapshot so new rows populate without waiting for a tick.
        const snap = await hub.getMany(syms);
        if (snap.length && socket.readyState === 1) socket.send(`{"t":"q","d":[${snap.map(encodeQuote).join(",")}]}`);
      } else if (msg.t === "ping") {
        socket.send('{"t":"pong"}');
      }
    });
    socket.on("close", () => {
      clients.delete(client);
      hub.setDemand(id, []);
    });
  });

  // ---------------------------------------------------------------- REST API
  const parseSymbols = (raw: unknown): string[] =>
    String(raw ?? "").split(",").map(normalizeSymbol).filter((s): s is string => !!s).slice(0, 500);

  app.get("/api/health", async () => ({ ok: true, broker: brokers.broker.id, provider: hub.providerName }));

  app.get("/api/bootstrap", async () => {
    const b = brokers.broker;
    const [account, positions, orders] = await Promise.all([b.account(), b.positions(), b.orders()]);
    const syms = new Set([...widgets.allSymbols(), ...positions.map((p) => p.symbol), ...orders.map((o) => o.symbol)]);
    return {
      broker: { id: b.id, name: b.displayName, live: b.live },
      provider: hub.providerName,
      settings: publicSettings(settings),
      widgets: widgets.list(),
      account,
      positions,
      orders: orders.slice(0, 200),
      instruments: Object.fromEntries([...syms].map((s) => [s, lookup(s)])),
    };
  });

  // widgets
  app.get("/api/widgets", async () => widgets.list());
  app.post<{ Body: { title?: string; symbols?: string[]; kind?: string; options?: unknown } }>("/api/widgets", async (req, reply) => {
    reply.code(201);
    return widgets.create(req.body ?? {});
  });
  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>("/api/widgets/:id", async (req) =>
    widgets.update(req.params.id, req.body ?? {}));
  app.delete<{ Params: { id: string } }>("/api/widgets/:id", async (req, reply) => {
    widgets.remove(req.params.id);
    reply.code(204);
  });
  app.put<{ Body: { ids?: string[] } }>("/api/widgets/order", async (req) => widgets.reorder(req.body?.ids));

  // market data
  app.get<{ Querystring: { symbols?: string } }>("/api/quotes", async (req) => hub.getMany(parseSymbols(req.query.symbols)));
  app.get<{ Querystring: { symbols?: string } }>("/api/instruments", async (req) =>
    Object.fromEntries(parseSymbols(req.query.symbols).map((s) => [s, lookup(s)])));
  app.get<{ Querystring: { q?: string } }>("/api/instruments/search", async (req) => {
    const q = String(req.query.q ?? "").slice(0, 32);
    const results = await provider.search(q);
    // Any well-formed ticker can be added, even if the provider doesn't know its name.
    const exact = normalizeSymbol(q);
    if (exact && !results.some((r) => r.symbol === exact)) results.push(lookup(exact));
    return results;
  });

  // options
  app.get<{ Params: { underlying: string } }>("/api/options/:underlying/expirations", async (req) => {
    const u = normalizeSymbol(req.params.underlying);
    if (!u || isOption(u)) throw new HttpError(400, "Invalid underlying symbol");
    return { underlying: u, expirations: listExpirations() };
  });
  app.get<{ Params: { underlying: string }; Querystring: { expiry?: string; strikes?: string } }>("/api/options/:underlying/chain", async (req) => {
    const u = normalizeSymbol(req.params.underlying);
    if (!u || isOption(u)) throw new HttpError(400, "Invalid underlying symbol");
    const expirations = listExpirations();
    // Default: the nearest expiration that isn't today's (0 DTE is rarely what you want to browse).
    const exp = expirations.find((e) => e.date === req.query.expiry) ?? expirations.find((e) => e.dte >= 1) ?? expirations[0];
    const each = Math.min(25, Math.max(2, Math.floor(Number(req.query.strikes)) || 8));
    const [uq] = await hub.getMany([u]);
    if (!uq) throw new HttpError(404, `No quote for ${u}`);
    const strikes = strikesAround(uq.last, each);
    const calls = strikes.map((k) => formatOcc(u, exp.date, "C", k));
    const puts = strikes.map((k) => formatOcc(u, exp.date, "P", k));
    const quotes = await hub.getMany([...calls, ...puts]);
    return {
      underlying: u, expiry: exp.date, dte: exp.dte, expirations, strikes, calls, puts,
      multiplier: CONTRACT_MULTIPLIER, riskFreeRate: optionModel.riskFreeRate, quotes,
    };
  });

  // trading
  app.get("/api/account", async () => brokers.broker.account());
  app.get("/api/positions", async () => brokers.broker.positions());
  app.get("/api/orders", async () => brokers.broker.orders());
  app.get<{ Querystring: { limit?: string } }>("/api/fills", async (req) =>
    brokers.broker.fills(Math.min(5000, Number(req.query.limit) || 500)));
  app.get("/api/pnl", async () => {
    const b = brokers.broker;
    const [account, fills] = await Promise.all([b.account(), b.fills(100_000)]);
    return { realizedPnl: account.realizedPnl, bySymbol: realizedBySymbol(fills) };
  });

  app.post<{ Body: OrderRequest }>("/api/orders", async (req, reply) => {
    const b = brokers.broker;
    if (b.live && !settings.liveTradingEnabled) {
      throw new HttpError(403, "Live trading is disabled. Enable it in Settings before sending real orders.");
    }
    if (!req.body || typeof req.body !== "object") throw new HttpError(400, "Order body required");
    const order = await b.placeOrder(req.body);
    reply.code(order.status === "rejected" ? 422 : 201);
    return order;
  });
  // Kill switch: cancel open orders and market-sell everything (or just `symbols`), right now.
  const killLog = storage.log<unknown>("kill-switch.log.jsonl");
  app.post<{ Body: { symbols?: unknown } }>("/api/kill-switch", async (req) => {
    const b = brokers.broker;
    if (b.live && !settings.liveTradingEnabled) {
      throw new HttpError(403, "Live trading is disabled. Enable it in Settings before sending real orders.");
    }
    const raw = req.body?.symbols;
    if (raw !== undefined && !Array.isArray(raw)) throw new HttpError(400, "symbols must be an array");
    const symbols = raw?.map(normalizeSymbol).filter((s): s is string => !!s);
    const report = await killSwitch(b, hub, symbols);
    killLog.append(report);
    broadcast(JSON.stringify({ t: "kill", d: report }));
    return report;
  });

  app.delete<{ Params: { id: string } }>("/api/orders/:id", async (req) => brokers.broker.cancelOrder(req.params.id));

  app.post<{ Body: { startingCash?: number } }>("/api/paper/reset", async (req) => {
    const b = brokers.broker;
    if (!(b instanceof PaperBroker)) throw new HttpError(400, "Reset is only available for the paper broker");
    const cash = req.body?.startingCash;
    if (cash !== undefined && !(Number(cash) > 0)) throw new HttpError(400, "startingCash must be > 0");
    b.reset(cash !== undefined ? Number(cash) : undefined);
    return b.account();
  });

  // settings
  app.get("/api/settings", async () => ({
    settings: publicSettings(settings),
    brokers: BROKERS,
    credentials: credentialStatus(),
    active: brokers.broker.id,
  }));

  app.get("/api/profit-guard", async () => ({
    settings: settings.profitGuard,
    positions: guard.status(),
    events: guard.recent(50),
  }));

  // Per-ticker kill-switch toggle.
  app.put<{ Params: { symbol: string }; Body: { enabled?: unknown } }>("/api/profit-guard/symbols/:symbol", async (req) => {
    const sym = normalizeSymbol(req.params.symbol);
    if (!sym) throw new HttpError(400, "Invalid symbol");
    if (typeof req.body?.enabled !== "boolean") throw new HttpError(400, "enabled must be true or false");
    const off = new Set(settings.profitGuard.disabledSymbols);
    if (req.body.enabled) off.delete(sym);
    else off.add(sym);
    settings.profitGuard = { ...settings.profitGuard, disabledSymbols: [...off].sort() };
    persist({ profitGuard: settings.profitGuard });
    broadcast(JSON.stringify({ t: "settings", d: publicSettings(settings) }));
    return settings.profitGuard;
  });

  app.put<{ Body: { broker?: BrokerId; liveTradingEnabled?: boolean; profitGuard?: { enabled?: unknown; dropPct?: unknown; floorPct?: unknown } } }>("/api/settings", async (req) => {
    const body = req.body ?? {};
    if (body.profitGuard !== undefined) {
      const pg = { ...settings.profitGuard };
      if (body.profitGuard.enabled !== undefined) pg.enabled = !!body.profitGuard.enabled;
      if (body.profitGuard.dropPct !== undefined) {
        const d = Number(body.profitGuard.dropPct);
        if (!(d >= 0.5 && d <= 50)) throw new HttpError(400, "dropPct must be between 0.5 and 50");
        pg.dropPct = d;
      }
      if (body.profitGuard.floorPct !== undefined) {
        const f = Number(body.profitGuard.floorPct);
        if (!(f >= 0 && f <= 5)) throw new HttpError(400, "floorPct must be between 0 and 5");
        pg.floorPct = f;
      }
      settings.profitGuard = pg;
      persist({ profitGuard: pg });
      broadcast(JSON.stringify({ t: "settings", d: publicSettings(settings) }));
    }
    if (body.broker !== undefined) {
      if (!BROKERS.some((b) => b.id === body.broker)) throw new HttpError(400, "Unknown broker");
      await brokers.use(body.broker); // throws (and keeps the old broker) if it can't connect
      settings.broker = body.broker;
      persist({ broker: body.broker });
    }
    if (body.liveTradingEnabled !== undefined) {
      settings.liveTradingEnabled = !!body.liveTradingEnabled;
      persist({ liveTradingEnabled: settings.liveTradingEnabled });
    }
    return { settings: publicSettings(settings), active: brokers.broker.id };
  });

  app.put<{ Params: { broker: string }; Body: { fields?: Record<string, unknown> } }>("/api/credentials/:broker", async (req) => {
    const info = BROKERS.find((b) => b.id === req.params.broker);
    if (!info) throw new HttpError(404, "Unknown broker");
    const allowed = new Set(info.fields.map((f) => f.key));
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.body?.fields ?? {})) {
      if (!allowed.has(k)) throw new HttpError(400, `Unknown field: ${k}`);
      if (typeof v !== "string" || v.length > 4096) throw new HttpError(400, `Invalid value for ${k}`);
      fields[k] = v.trim();
    }
    saveCredentials(info.id, fields);
    return { credentials: credentialStatus() };
  });

  // ---------------------------------------------------------------- P&L & taxes
  const taxBook = new TaxBook(storage, () => opts.taxRules ?? loadTaxRules());
  app.get<{ Querystring: { year?: string } }>("/api/tax/report", async (req) => {
    const y = req.query.year === undefined ? Number(nyDate(Date.now()).slice(0, 4)) : Number(req.query.year);
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, "Invalid year");
    const b = brokers.broker;
    return taxBook.report({ year: y, broker: b.id, fills: await b.fills(1_000_000), quote: (s) => hub.get(s) });
  });
  app.put<{ Body: Record<string, unknown> }>("/api/tax/profile", async (req) => {
    if (!req.body || typeof req.body !== "object") throw new HttpError(400, "Profile body required");
    return taxBook.setProfile(req.body);
  });
  app.get("/api/dividends", async () => taxBook.dividends(brokers.broker.id));
  app.post<{ Body: Record<string, unknown> }>("/api/dividends", async (req, reply) => {
    if (!req.body || typeof req.body !== "object") throw new HttpError(400, "Dividend body required");
    reply.code(201);
    return taxBook.addDividend(brokers.broker.id, req.body);
  });
  app.delete<{ Params: { id: string } }>("/api/dividends/:id", async (req, reply) => {
    if (!taxBook.deleteDividend(req.params.id)) throw new HttpError(404, "Dividend not found");
    reply.code(204);
  });

  // ---------------------------------------------------------------- static web build
  const webDist = join(ROOT, "web", "dist");
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, maxAge: "1h", immutable: false });
    app.setNotFoundHandler((req: FastifyRequest, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html", { maxAge: 0 });
    });
  }

  hub.start();

  const close = async () => {
    hub.stop();
    await app.close();
    await brokers.broker.dispose();
    storage.flushAll();
  };

  return { app, hub, brokers, widgets, storage, close };
}

function publicSettings(s: AppSettings) {
  return {
    broker: s.broker,
    liveTradingEnabled: s.liveTradingEnabled,
    marketData: { provider: s.marketData.provider, tickMs: s.marketData.tickMs, flushMs: s.marketData.flushMs },
    paper: s.paper,
    profitGuard: s.profitGuard,
  };
}
