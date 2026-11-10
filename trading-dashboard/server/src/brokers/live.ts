import type { Account, Fill, Order, OrderRequest, Position } from "../types.js";
import type { Broker } from "./broker.js";
import { Emitter } from "./broker.js";
import { HttpError } from "../util.js";

export interface CredentialField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  help?: string;
}

/**
 * Base class for real-money broker adapters. It checks that the required credentials are
 * present, then each subclass implements the REST/WebSocket calls.
 *
 * The Robinhood and Webull adapters below are scaffolds: credentials, settings UI and
 * wiring are in place, and the API calls are left as TODOs (see docs/BROKERS.md) so you
 * can implement them against the API access you actually have.
 */
export abstract class LiveBroker extends Emitter implements Broker {
  abstract readonly id: string;
  abstract readonly displayName: string;
  readonly live = true;

  constructor(protected creds: Record<string, string>, protected fields: CredentialField[]) {
    super();
  }

  async init(): Promise<void> {
    const missing = this.fields.filter((f) => f.required && !this.creds[f.key]).map((f) => f.label);
    if (missing.length) throw new HttpError(400, `${this.displayName}: missing credentials: ${missing.join(", ")}`);
    await this.connect();
  }

  async dispose(): Promise<void> {}

  watchedSymbols(): string[] {
    return [];
  }

  protected abstract connect(): Promise<void>;
  abstract account(): Promise<Account>;
  abstract positions(): Promise<Position[]>;
  abstract orders(): Promise<Order[]>;
  abstract fills(limit?: number): Promise<Fill[]>;
  abstract placeOrder(req: OrderRequest): Promise<Order>;
  abstract cancelOrder(orderId: string): Promise<Order>;

  protected todo(what: string): never {
    throw new HttpError(501, `${this.displayName} adapter: ${what} is not implemented yet (see docs/BROKERS.md)`);
  }
}

// ---------------------------------------------------------------------------------------

export const ROBINHOOD_FIELDS: CredentialField[] = [
  { key: "username", label: "Username / email", secret: false, required: true },
  { key: "password", label: "Password", secret: true, required: true },
  { key: "mfaSecret", label: "MFA (TOTP) secret", secret: true, required: false, help: "Base32 secret from authenticator setup, for unattended login" },
  { key: "accountNumber", label: "Account number", secret: false, required: false },
];

export class RobinhoodBroker extends LiveBroker {
  readonly id = "robinhood";
  readonly displayName = "Robinhood";
  constructor(creds: Record<string, string>) {
    super(creds, ROBINHOOD_FIELDS);
  }
  protected async connect(): Promise<void> {
    // TODO: authenticate (OAuth password grant + MFA) and store the bearer token in memory.
    this.todo("login");
  }
  account(): Promise<Account> { return this.todo("account"); }
  positions(): Promise<Position[]> { return this.todo("positions"); }
  orders(): Promise<Order[]> { return this.todo("orders"); }
  fills(): Promise<Fill[]> { return this.todo("fills"); }
  placeOrder(_req: OrderRequest): Promise<Order> { return this.todo("placeOrder"); }
  cancelOrder(_id: string): Promise<Order> { return this.todo("cancelOrder"); }
}

// ---------------------------------------------------------------------------------------

export const WEBULL_FIELDS: CredentialField[] = [
  { key: "appKey", label: "App key", secret: false, required: true, help: "From the Webull OpenAPI developer portal" },
  { key: "appSecret", label: "App secret", secret: true, required: true },
  { key: "accountId", label: "Account ID", secret: false, required: true },
  { key: "region", label: "Region (us / hk / jp)", secret: false, required: false },
];

export class WebullBroker extends LiveBroker {
  readonly id = "webull";
  readonly displayName = "Webull";
  constructor(creds: Record<string, string>) {
    super(creds, WEBULL_FIELDS);
  }
  protected async connect(): Promise<void> {
    // TODO: sign requests with appKey/appSecret (HMAC) and verify the account.
    this.todo("connect");
  }
  account(): Promise<Account> { return this.todo("account"); }
  positions(): Promise<Position[]> { return this.todo("positions"); }
  orders(): Promise<Order[]> { return this.todo("orders"); }
  fills(): Promise<Fill[]> { return this.todo("fills"); }
  placeOrder(_req: OrderRequest): Promise<Order> { return this.todo("placeOrder"); }
  cancelOrder(_id: string): Promise<Order> { return this.todo("cancelOrder"); }
}
