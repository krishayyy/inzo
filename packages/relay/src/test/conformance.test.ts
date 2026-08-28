import request from "supertest";
import { describeRelayConformance, type RelayClient } from "../../../conformance/suite.js";
import { createApp } from "../app.js";
import { RelayStore } from "../lib/store.js";

/**
 * The shared conformance suite, driven against the Express relay.
 *
 * Only the transport differs from the relay-cf run — the assertions live in
 * one file so the two implementations cannot drift apart quietly.
 */
function makeClient(): RelayClient {
  const app = createApp(new RelayStore());
  return {
    async post(path, body = {}, headers = {}) {
      const res = await request(app).post(path).set(headers).send(body as object);
      return { status: res.status, body: res.body };
    },
    async get(path, headers = {}) {
      const res = await request(app).get(path).set(headers);
      return { status: res.status, body: res.body };
    },
  };
}

describeRelayConformance("relay (express/sqlite)", makeClient);
