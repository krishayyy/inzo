import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { requestLogger } from "../lib/logging.js";
import { RelayStore } from "../lib/store.js";

describe("request logging", () => {
  it("never writes a query string, because the stream carries its token in one", async () => {
    const lines: string[] = [];
    const app = express();
    app.use(requestLogger((line) => lines.push(line)));
    app.get("/pairings/:id/stream", (_req, res) => res.end());

    const secret = "s3cret-agent-token";
    await request(app).get(`/pairings/pairing_1/stream?token=${secret}`);

    const all = lines.join("");
    expect(all).not.toContain(secret);
    expect(all).not.toContain("token=");
    // The path itself is still there — this is a redaction, not silence.
    expect(all).toContain("/pairings/pairing_1/stream");
  });

  it("skips health checks so they do not drown the log", async () => {
    const lines: string[] = [];
    const app = express();
    app.use(requestLogger((line) => lines.push(line)));
    app.get("/health", (_req, res) => {
      res.json({ ok: true });
    });

    await request(app).get("/health");
    expect(lines).toHaveLength(0);
  });
});

describe("expired code sweep", () => {
  it("drops unused expired codes and keeps ones that became pairings", async () => {
    const store = new RelayStore();
    const app = createApp(store);

    const abandoned = (await request(app).post("/pairings").send({})).body;
    const used = (await request(app).post("/pairings").send({})).body;
    await request(app).post(`/pairings/${used.code}/join`).send({});

    // Nothing has expired yet.
    expect(store.purgeExpiredCodes()).toBe(0);

    // Sweep as of well past the 15-minute TTL.
    const later = new Date(Date.now() + 60 * 60 * 1000);
    expect(store.purgeExpiredCodes(later)).toBe(1);

    // The abandoned code is gone; the used one is still there backing a pairing.
    expect((await request(app).post(`/pairings/${abandoned.code}/join`).send({})).status).toBe(404);
    expect((await request(app).post(`/pairings/${used.code}/join`).send({})).status).toBe(409);
    store.close();
  });
});

describe("hardening", () => {
  it("does not advertise the server framework", async () => {
    const store = new RelayStore();
    const res = await request(createApp(store)).get("/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    store.close();
  });

  it("rejects an oversized body instead of buffering it", async () => {
    const store = new RelayStore();
    const app = createApp(store);
    const creator = (await request(app).post("/pairings").send({})).body;
    const joiner = (await request(app).post(`/pairings/${creator.code}/join`).send({})).body;

    const res = await request(app)
      .post(`/pairings/${joiner.pairingId}/messages`)
      .set("Authorization", `Bearer ${creator.agentToken}`)
      .send({ body: "x".repeat(200_000) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("entity_too_large");
    store.close();
  });

  it("answers malformed JSON with 400 rather than a 500 and a stack trace", async () => {
    const store = new RelayStore();
    const res = await request(createApp(store))
      .post("/pairings")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBeTruthy();
    store.close();
  });
});
