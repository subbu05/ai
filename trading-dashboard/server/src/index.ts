import { loadSettings } from "./config.js";
import { buildApp } from "./server.js";

const settings = loadSettings();
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
