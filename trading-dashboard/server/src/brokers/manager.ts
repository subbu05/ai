import type { BrokerId } from "../config.js";
import { loadCredentials } from "../config.js";
import type { Broker } from "./broker.js";
import { createBroker, type BrokerDeps } from "./index.js";

type Listener = (b: Broker) => void;

/**
 * Holds the active broker and lets the app hot-swap it at runtime (Settings > Broker).
 * A broker that fails to init (bad credentials, unimplemented adapter) is discarded and the
 * previous one stays active.
 */
export class BrokerManager {
  private current!: Broker;
  private detach: (() => void)[] = [];
  private listeners = new Set<Listener>();

  constructor(private deps: Omit<BrokerDeps, "credentials">) {}

  get broker(): Broker {
    return this.current;
  }

  /** Called with the new broker after every successful switch (re-attach event handlers here). */
  onSwitch(fn: Listener): void {
    this.listeners.add(fn);
  }

  /** Subscribe to broker events that survive broker switches. */
  attach(wire: (b: Broker) => (() => void)[]): void {
    this.onSwitch((b) => {
      this.detach.push(...wire(b));
    });
  }

  async use(id: BrokerId): Promise<Broker> {
    const next = createBroker(id, { ...this.deps, credentials: loadCredentials() });
    try {
      await next.init();
    } catch (err) {
      await next.dispose().catch(() => {});
      throw err;
    }
    const prev = this.current;
    for (const d of this.detach.splice(0)) d();
    this.current = next;
    if (prev) await prev.dispose();
    for (const fn of this.listeners) fn(next);
    return next;
  }
}
