import { SELF } from "cloudflare:test";
import { describeRelayConformance, type RelayClient } from "../../conformance/suite.js";

/**
 * The shared conformance suite, driven against the Workers relay.
 *
 * `SELF` is a single shared worker for the whole file rather than a fresh
 * instance per test, which is fine: every assertion in the suite creates its
 * own pairing, and a pairing is its own Durable Object.
 */
function makeClient(): RelayClient {
  const base = "https://relay.test";
  return {
    async post(path, body = {}, headers = {}) {
      const res = await SELF.fetch(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    async get(path, headers = {}) {
      const res = await SELF.fetch(`${base}${path}`, { headers });
      return { status: res.status, body: await res.json() };
    },
  };
}

describeRelayConformance("relay-cf (workers/durable objects)", makeClient);
