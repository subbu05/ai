import { loadSettings, lockDownConfigFiles } from "./config.js";
import { buildApp } from "./server.js";

const settings = loadSettings();

// The API has no login: anyone who can reach it can place trades and change settings.
// Refuse to listen on a network interface unless explicitly forced.
const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(settings.host);
if (!loopback && process.env.TD_ALLOW_REMOTE !== "1") {
  console.error(`Refusing to listen on ${settings.host}: this server has no login, so anyone on your network could trade.\n` +
    `Use 127.0.0.1 (the default). To override anyway, set TD_ALLOW_REMOTE=1.`);
  process.exit(1);
}
if (!loopback) console.warn(`WARNING: listening on ${settings.host} with no authentication.`);
lockDownConfigFiles();
const ctx = await buildApp(settings, { logger: process.env.LOG === "1" });
await ctx.app.listen({ host: settings.host, port: settings.port });
console.log(`Trading dashboard API on http://${settings.host}:${settings.port}  (broker: ${ctx.brokers.broker.id}, data: ${ctx.hub.providerName})`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await ctx.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
