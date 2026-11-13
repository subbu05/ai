import type { BrokerId, Credentials } from "../config.js";
import type { QuoteHub } from "../market/quoteHub.js";
import type { Storage } from "../storage.js";
import type { Broker } from "./broker.js";
import { PaperBroker } from "./paper.js";
import { RobinhoodBroker, WebullBroker, ROBINHOOD_FIELDS, WEBULL_FIELDS, type CredentialField } from "./live.js";

export interface BrokerInfo {
  id: BrokerId;
  name: string;
  live: boolean;
  implemented: boolean;
  fields: CredentialField[];
}

export const BROKERS: BrokerInfo[] = [
  { id: "paper", name: "Paper (simulated)", live: false, implemented: true, fields: [] },
  { id: "robinhood", name: "Robinhood", live: true, implemented: false, fields: ROBINHOOD_FIELDS },
  { id: "webull", name: "Webull", live: true, implemented: false, fields: WEBULL_FIELDS },
];

export interface BrokerDeps {
  storage: Storage;
  hub: QuoteHub;
  credentials: Credentials;
  startingCash: number;
}

export function createBroker(id: BrokerId, deps: BrokerDeps): Broker {
  switch (id) {
    case "paper":
      return new PaperBroker(deps.storage, deps.hub, deps.startingCash);
    case "robinhood":
      return new RobinhoodBroker(deps.credentials.robinhood ?? {});
    case "webull":
      return new WebullBroker(deps.credentials.webull ?? {});
    default:
      throw new Error(`Unknown broker: ${id as string}`);
  }
}
