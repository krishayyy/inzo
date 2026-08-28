/**
 * Cross-relay conformance suite.
 *
 * `packages/relay` (Express + SQLite) and `packages/relay-cf` (Workers +
 * Durable Objects) are independent implementations of the same protocol. Every
 * feature costs double — that is accepted — but until this file existed
 * nothing proved they *agree*, and drift shows up as two members of one
 * session seeing different realities.
 *
 * It was not hypothetical. Writing this suite found relay-cf's join response
 * missing `agentId`, which the CLI writes straight into its session file: on
 * the default hosted relay, `inzo watch` rendered your own messages as the
 * peer's and re-prompted you to approve a plan you had already approved.
 *
 * Both relays import this and supply their own transport — supertest against
 * an in-process app, or `SELF.fetch` inside the Workers runtime — so the
 * assertions are identical and only the plumbing differs.
 */
import { describe, expect, it } from "vitest";

export interface RelayResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface RelayClient {
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<RelayResponse>;
  get(path: string, headers?: Record<string, string>): Promise<RelayResponse>;
}

/** A fresh client per test. Implementations may return a shared transport. */
export type MakeClient = () => Promise<RelayClient> | RelayClient;

const VALID_REPO = { url: "https://github.com/owner/repo.git", branch: "inzo/7fk2q9", name: "repo" };

/**
 * Descriptors every relay must refuse with 400.
 *
 * The URL rows are the ones that matter most: that value reaches a joiner's
 * `git clone`, and the relay is explicitly not a trusted source of truth. A
 * relay that stores one of these hands code execution to every joiner.
 */
const REJECTED: Array<[string, unknown]> = [
  ["an unknown mode", { mode: "cowrok", repo: null }],
  ["a missing mode", { repo: null }],
  ["a non-object session", "cowork"],
  ["an ext:: clone url", { mode: "cowork", repo: { ...VALID_REPO, url: "ext::sh -c 'id'" } }],
  ["a file:// clone url", { mode: "cowork", repo: { ...VALID_REPO, url: "file:///home/victim/.ssh" } }],
  ["a git:// clone url", { mode: "cowork", repo: { ...VALID_REPO, url: "git://github.com/a/b.git" } }],
  ["a clone url starting with a dash", { mode: "cowork", repo: { ...VALID_REPO, url: "--upload-pack=/bin/sh" } }],
  ["a clone url with a newline", { mode: "cowork", repo: { ...VALID_REPO, url: "https://h/a\nb" } }],
  ["a branch with a traversal", { mode: "cowork", repo: { ...VALID_REPO, branch: "inzo/../../etc" } }],
  ["a branch starting with a dash", { mode: "cowork", repo: { ...VALID_REPO, branch: "-oProxyCommand=sh" } }],
  ["a repo name with a path separator", { mode: "cowork", repo: { ...VALID_REPO, name: "../../.ssh" } }],
  ["a repo name that is dot-dot", { mode: "cowork", repo: { ...VALID_REPO, name: ".." } }],
];

export function describeRelayConformance(relayName: string, makeClient: MakeClient): void {
  /** Creates a pairing, returning both sides' bearer auth. */
  async function pair(client: RelayClient, session?: unknown) {
    const created = await client.post("/pairings", session === undefined ? {} : { session });
    const joined = await client.post(`/pairings/${created.body.code}/join`, {});
    return {
      created,
      joined,
      pairingId: joined.body.pairingId as string,
      a: { auth: { Authorization: `Bearer ${created.body.agentToken}` }, agentId: created.body.agentId as string },
      b: { auth: { Authorization: `Bearer ${joined.body.agentToken}` }, agentId: joined.body.agentId as string },
    };
  }

  describe(`${relayName} — protocol conformance`, () => {
    describe("pairing lifecycle", () => {
      it("returns a code, the creator's identity, and full scope", async () => {
        const client = await makeClient();
        const created = await client.post("/pairings", {});
        expect(created.status).toBe(201);
        expect(typeof created.body.code).toBe("string");
        expect(typeof created.body.agentId).toBe("string");
        expect(typeof created.body.agentToken).toBe("string");
        expect(created.body.scope).toContain("commands:run");
        expect(created.body.pairingId).toBeNull();
      });

      it("returns the joiner's own agentId, not only agentA/agentB", async () => {
        // Regression: relay-cf omitted this, and the CLI stores it verbatim.
        const client = await makeClient();
        const { joined } = await pair(client);
        expect(typeof joined.body.agentId).toBe("string");
        expect(joined.body.agentId).not.toBe("");
        expect(joined.body.members).toContain(joined.body.agentId);
      });

      it("names the peer and lists exactly two members after a bootstrap join", async () => {
        const client = await makeClient();
        const { joined } = await pair(client);
        expect(joined.status).toBe(201);
        expect(typeof joined.body.peerAgentId).toBe("string");
        expect(joined.body.members).toHaveLength(2);
        expect(joined.body.agentId).not.toBe(joined.body.peerAgentId);
      });

      it("refuses an unknown code", async () => {
        const client = await makeClient();
        const res = await client.post("/pairings/INZO-ZZZZZZ/join", {});
        expect(res.status).toBe(404);
      });

      it("refuses a code that has already been used", async () => {
        const client = await makeClient();
        const created = await client.post("/pairings", {});
        await client.post(`/pairings/${created.body.code}/join`, {});
        const second = await client.post(`/pairings/${created.body.code}/join`, {});
        expect(second.status).toBe(409);
      });
    });

    describe("session descriptor", () => {
      it("defaults to no descriptor", async () => {
        const client = await makeClient();
        const { created, joined } = await pair(client);
        expect(created.body.session ?? null).toBeNull();
        expect(joined.body.session ?? null).toBeNull();
      });

      it("carries the descriptor from the code into the join response", async () => {
        // The joiner must learn what to clone from the join itself — no second
        // round trip, and no window where the pairing exists but its repo does
        // not.
        const client = await makeClient();
        const session = { mode: "cowork", repo: VALID_REPO };
        const { created, joined } = await pair(client, session);
        expect(created.body.session).toEqual(session);
        expect(joined.body.session).toEqual(session);
      });

      it("accepts a descriptor with no remote", async () => {
        const client = await makeClient();
        const session = { mode: "research", repo: { url: null, branch: "inzo/abc", name: "app" } };
        const { joined } = await pair(client, session);
        expect(joined.body.session).toEqual(session);
      });

      it("stores the descriptor on the pairing, readable afterwards", async () => {
        const client = await makeClient();
        const session = { mode: "build", repo: VALID_REPO };
        const { pairingId, a } = await pair(client, session);
        const read = await client.get(`/pairings/${pairingId}/session`, a.auth);
        expect(read.status).toBe(200);
        expect(read.body.session).toEqual(session);
      });

      it("replaces the descriptor on POST", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "research", repo: null });
        const next = { mode: "build", repo: VALID_REPO };
        const res = await client.post(`/pairings/${pairingId}/session`, { session: next }, a.auth);
        expect(res.status).toBe(200);
        expect(res.body.session).toEqual(next);

        const read = await client.get(`/pairings/${pairingId}/session`, a.auth);
        expect(read.body.session).toEqual(next);
      });

      it("lets any member change the mode, and both sides see it", async () => {
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "research", repo: null });
        await client.post(`/pairings/${pairingId}/session`, { session: { mode: "plan", repo: null } }, b.auth);
        const seenByA = await client.get(`/pairings/${pairingId}/session`, a.auth);
        expect(seenByA.body.session.mode).toBe("plan");
      });

      it("requires authentication to read or write", async () => {
        const client = await makeClient();
        const { pairingId } = await pair(client, { mode: "cowork", repo: null });
        expect((await client.get(`/pairings/${pairingId}/session`)).status).toBe(401);
        expect((await client.post(`/pairings/${pairingId}/session`, { session: { mode: "plan", repo: null } })).status).toBe(401);
      });

      it("moves freely between modes without touching anyone's credential", async () => {
        // research -> plan -> build is the normal team arc. Scope narrows
        // one-way, so binding mode to scope would make every step of the main
        // workflow the expensive one. It must not.
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "research", repo: null });
        const before = await client.get("/pairings/mine", a.auth);

        for (const mode of ["plan", "build", "cowork", "research"]) {
          const res = await client.post(`/pairings/${pairingId}/session`, { session: { mode, repo: null } }, a.auth);
          expect(res.status).toBe(200);
        }

        const after = await client.get("/pairings/mine", a.auth);
        expect(after.body.pairing.scope).toEqual(before.body.pairing.scope);
      });

      it("advances research and plan to build when the plan locks, and leaves cowork alone", async () => {
        // The phase gate IS the consent gate: the moment unanimous approval
        // lands the team is by definition building, so making a human type
        // `inzo mode build` is ceremony. Both relays must agree on that, or
        // two members read the same pairing as being in different phases.
        for (const [from, expected] of [
          ["research", "build"],
          ["plan", "build"],
          ["cowork", "cowork"],
          ["build", "build"],
        ] as const) {
          const client = await makeClient();
          const { pairingId, a, b } = await pair(client, { mode: from, repo: null });

          const proposed = await client.post(
            `/pairings/${pairingId}/plan`,
            { goal: "ship it", items: [{ owner: a.agentId, task: "do the thing" }] },
            a.auth,
          );
          const version = proposed.body.plan.version;

          await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, a.auth);
          const mid = await client.get(`/pairings/${pairingId}/session`, a.auth);
          // One approval is not consent — nothing moves until the plan locks.
          expect(mid.body.session.mode).toBe(from);

          await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, b.auth);
          const after = await client.get(`/pairings/${pairingId}/session`, b.auth);
          expect(after.body.session.mode).toBe(expected);
        }
      });

      it("does not invent a descriptor for a session that never had one", async () => {
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client);
        const proposed = await client.post(
          `/pairings/${pairingId}/plan`,
          { goal: "ship it", items: [{ owner: a.agentId, task: "do the thing" }] },
          a.auth,
        );
        const version = proposed.body.plan.version;
        await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, a.auth);
        await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, b.auth);
        expect((await client.get(`/pairings/${pairingId}/session`, a.auth)).body.session ?? null).toBeNull();
      });

      describe("rejects malformed descriptors identically", () => {
        for (const [why, session] of REJECTED) {
          it(`rejects ${why} at creation`, async () => {
            const client = await makeClient();
            const res = await client.post("/pairings", { session });
            expect(res.status).toBe(400);
          });

          it(`rejects ${why} on update`, async () => {
            const client = await makeClient();
            const { pairingId, a } = await pair(client);
            const res = await client.post(`/pairings/${pairingId}/session`, { session }, a.auth);
            expect(res.status).toBe(400);
          });
        }
      });
    });

    describe("invites", () => {
      it("inherits the pairing's CURRENT descriptor, not the bootstrap code's", async () => {
        // A 5th member must land on the same branch as the 2nd, even though
        // the descriptor changed after the original code was minted.
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "research", repo: null });

        const current = { mode: "cowork", repo: VALID_REPO };
        await client.post(`/pairings/${pairingId}/session`, { session: current }, a.auth);

        const invite = await client.post(`/pairings/${pairingId}/invite`, {}, a.auth);
        expect(invite.status).toBe(201);

        const third = await client.post(`/pairings/${invite.body.code}/join`, {});
        expect(third.status).toBe(201);
        expect(third.body.session).toEqual(current);
        expect(third.body.pairingId).toBe(pairingId);
      });

      it("grows the membership list", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client);
        const invite = await client.post(`/pairings/${pairingId}/invite`, {}, a.auth);
        const third = await client.post(`/pairings/${invite.body.code}/join`, {});
        expect(third.body.members).toHaveLength(3);
        expect(third.body.members).toContain(third.body.agentId);
      });
    });
  });
}
