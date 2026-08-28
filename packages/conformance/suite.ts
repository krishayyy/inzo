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

  /** Grows a pairing to `size` members, returning every member's auth. */
  async function team(client: RelayClient, size: number, session?: unknown) {
    const { pairingId, a, b } = await pair(client, session);
    const members = [a, b];
    for (let i = 2; i < size; i++) {
      const invite = await client.post(`/pairings/${pairingId}/invite`, {}, a.auth);
      const joined = await client.post(`/pairings/${invite.body.code}/join`, {});
      members.push({
        auth: { Authorization: `Bearer ${joined.body.agentToken}` },
        agentId: joined.body.agentId as string,
      });
    }
    return { pairingId, members };
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

    describe("presence", () => {
      const VALID = { branch: "inzo/7fk2q9", head: "a1b2c3d", dirty: ["src/api.ts"], ahead: 2, behind: 0, conflicted: false };

      it("starts empty and returns what a member posts", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });

        expect((await client.get(`/pairings/${pairingId}/presence`, a.auth)).body.presence).toEqual([]);

        const posted = await client.post(`/pairings/${pairingId}/presence`, { presence: VALID }, a.auth);
        expect(posted.status).toBe(200);
        expect(posted.body.presence).toMatchObject({ ...VALID, agentId: a.agentId });
        expect(typeof posted.body.presence.at).toBe("string");
      });

      it("shows every member to every other member", async () => {
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/presence`, { presence: VALID }, a.auth);
        await client.post(
          `/pairings/${pairingId}/presence`,
          { presence: { ...VALID, dirty: ["web/App.tsx"], ahead: 0, behind: 2 } },
          b.auth,
        );

        const seen = await client.get(`/pairings/${pairingId}/presence`, b.auth);
        expect(seen.body.presence).toHaveLength(2);
        expect(seen.body.presence.map((entry: { agentId: string }) => entry.agentId).sort()).toEqual(
          [a.agentId, b.agentId].sort(),
        );
      });

      it("is last-write-wins per member, not a log", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/presence`, { presence: VALID }, a.auth);
        await client.post(`/pairings/${pairingId}/presence`, { presence: { ...VALID, dirty: ["b.ts"], ahead: 9 } }, a.auth);

        const seen = await client.get(`/pairings/${pairingId}/presence`, a.auth);
        expect(seen.body.presence).toHaveLength(1);
        expect(seen.body.presence[0]).toMatchObject({ dirty: ["b.ts"], ahead: 9 });
      });

      it("never reaches the audit log", async () => {
        // A heartbeat inside a tamper-evident record devalues the record.
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/presence`, { presence: VALID }, a.auth);

        const audit = await client.get(`/pairings/${pairingId}/audit`, a.auth);
        const actions = (audit.body.records ?? []).map((record: { action: string }) => record.action);
        expect(actions.filter((action: string) => action.includes("presence"))).toEqual([]);
      });

      it("requires authentication", async () => {
        const client = await makeClient();
        const { pairingId } = await pair(client, { mode: "cowork", repo: null });
        expect((await client.get(`/pairings/${pairingId}/presence`)).status).toBe(401);
        expect((await client.post(`/pairings/${pairingId}/presence`, { presence: VALID })).status).toBe(401);
      });

      describe("rejects malformed presence identically", () => {
        // The caps are not cosmetic: presence fans out to every member's
        // terminal and is held in memory, so an uncapped dirty list is both a
        // memory cost and a way to flood a teammate's screen.
        const BAD: Array<[string, unknown]> = [
          ["a missing branch", { ...VALID, branch: undefined }],
          ["a branch with a traversal", { ...VALID, branch: "inzo/../../etc" }],
          ["a non-hex head", { ...VALID, head: "not-a-sha" }],
          ["a non-array dirty list", { ...VALID, dirty: "src/api.ts" }],
          ["a dirty list over the cap", { ...VALID, dirty: Array.from({ length: 101 }, (_, i) => `f${i}.ts`) }],
          ["a dirty path with a control character", { ...VALID, dirty: ["src/\u0000.ts"] }],
          ["a negative ahead", { ...VALID, ahead: -1 }],
          ["a fractional behind", { ...VALID, behind: 1.5 }],
          ["a non-object payload", "dirty"],
        ];

        for (const [why, presence] of BAD) {
          it(`rejects ${why}`, async () => {
            const client = await makeClient();
            const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
            const res = await client.post(`/pairings/${pairingId}/presence`, { presence }, a.auth);
            expect(res.status).toBe(400);
          });
        }
      });
    });



    describe("N-party (P0-3)", () => {
      it("reports every member's own scope and revocation, at any size", async () => {
        // The field that makes 3+ member shared commands possible at all:
        // without a live per-member authority check there is nothing to
        // verify against, and the honest response to an unverifiable check is
        // to refuse the work.
        const client = await makeClient();
        const { pairingId, members } = await team(client, 5);
        expect(members).toHaveLength(5);

        const mine = await client.get("/pairings/mine", members[0].auth);
        expect(mine.body.pairing.members).toHaveLength(5);
        expect(mine.body.pairing.memberDetails).toHaveLength(5);
        for (const detail of mine.body.pairing.memberDetails) {
          expect(members.map((m) => m.agentId)).toContain(detail.agentId);
          expect(detail.scope).toContain("commands:run");
          expect(detail.revoked).toBe(false);
        }
        expect(pairingId).toBeTruthy();
      });

      it("stops naming a peer past two members, but still lists them all", async () => {
        const client = await makeClient();
        const { members } = await team(client, 3);
        const mine = await client.get("/pairings/mine", members[0].auth);
        // "the other one" is not well defined with three people.
        expect(mine.body.pairing.peerAgentId).toBeNull();
        expect(mine.body.pairing.members).toHaveLength(3);
      });

      it("requires every member's approval to lock a plan", async () => {
        const client = await makeClient();
        const { pairingId, members } = await team(client, 5);

        const proposed = await client.post(
          `/pairings/${pairingId}/plan`,
          { goal: "ship it", items: [{ owner: members[0].agentId, task: "do the thing" }] },
          members[0].auth,
        );
        const version = proposed.body.plan.version;

        for (let i = 0; i < 4; i++) {
          const res = await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, members[i].auth);
          expect(res.body.plan.locked, `locked after only ${i + 1} of 5 approvals`).toBe(false);
        }
        const last = await client.post(`/pairings/${pairingId}/plan/approve`, { planVersion: version }, members[4].auth);
        expect(last.body.plan.locked).toBe(true);
      });

      it("revokes one named member and leaves the rest live", async () => {
        const client = await makeClient();
        const { pairingId, members } = await team(client, 4);
        const victim = members[2];

        const res = await client.post(`/pairings/${pairingId}/revoke`, { target: victim.agentId }, members[0].auth);
        expect(res.status).toBe(200);
        expect(res.body.revocation.revokedAgentId).toBe(victim.agentId);

        const mine = await client.get("/pairings/mine", members[0].auth);
        const byId = new Map(
          mine.body.pairing.memberDetails.map((d: { agentId: string; revoked: boolean }) => [d.agentId, d.revoked]),
        );
        expect(byId.get(victim.agentId)).toBe(true);
        for (const member of members.filter((m) => m.agentId !== victim.agentId)) {
          expect(byId.get(member.agentId), `${member.agentId} should still be live`).toBe(false);
        }

        // And the ejected member is actually cut off, not merely flagged.
        expect((await client.get("/pairings/mine", victim.auth)).status).toBe(401);
      });

      it("refuses to revoke a non-member", async () => {
        const client = await makeClient();
        const { pairingId, members } = await team(client, 3);
        const res = await client.post(`/pairings/${pairingId}/revoke`, { target: "agent_notreal" }, members[0].auth);
        expect(res.status).toBe(400);
      });

      it("shows presence for every member at once", async () => {
        const client = await makeClient();
        const { pairingId, members } = await team(client, 5, { mode: "cowork", repo: null });
        for (const member of members) {
          await client.post(
            `/pairings/${pairingId}/presence`,
            { presence: { branch: "inzo/7fk2q9", head: "a1b2c3d", dirty: ["shared.ts"], ahead: 0, behind: 0, conflicted: false } },
            member.auth,
          );
        }
        const seen = await client.get(`/pairings/${pairingId}/presence`, members[0].auth);
        expect(seen.body.presence).toHaveLength(5);
      });
    });


    describe("shared context ledger (T-7)", () => {
      const ENTRY = { path: "src/api.ts", sha: "a1b2c3d4e5f", summary: "Express router. Exports createApi()." };

      it("misses before anything is published, and hits after", async () => {
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "cowork", repo: null });

        const miss = await client.get(`/pairings/${pairingId}/context?path=${ENTRY.path}&sha=${ENTRY.sha}`, b.auth);
        expect(miss.status).toBe(200);
        expect(miss.body.context).toBeNull();

        const put = await client.post(`/pairings/${pairingId}/context`, { context: ENTRY }, a.auth);
        expect(put.status).toBe(200);
        expect(put.body.context).toMatchObject({ ...ENTRY, agentId: a.agentId });

        // The whole point: B reads A's summary instead of the file.
        const hit = await client.get(`/pairings/${pairingId}/context?path=${ENTRY.path}&sha=${ENTRY.sha}`, b.auth);
        expect(hit.body.context.summary).toBe(ENTRY.summary);
        expect(hit.body.context.agentId).toBe(a.agentId);
      });

      it("misses once the file changes, because the sha is the key", async () => {
        // This is the entire cache-coherence story: a summary is bound to the
        // exact bytes it describes, so a stale entry cannot be served at all.
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/context`, { context: ENTRY }, a.auth);

        const afterEdit = await client.get(`/pairings/${pairingId}/context?path=${ENTRY.path}&sha=ffffff9`, b.auth);
        expect(afterEdit.body.context).toBeNull();
      });

      it("does not serve one file's summary for another path", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/context`, { context: ENTRY }, a.auth);

        const other = await client.get(`/pairings/${pairingId}/context?path=src/other.ts&sha=${ENTRY.sha}`, a.auth);
        expect(other.body.context).toBeNull();
      });

      it("replaces an entry rather than duplicating it", async () => {
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/context`, { context: ENTRY }, a.auth);
        await client.post(`/pairings/${pairingId}/context`, { context: { ...ENTRY, summary: "Revised." } }, b.auth);

        const hit = await client.get(`/pairings/${pairingId}/context?path=${ENTRY.path}&sha=${ENTRY.sha}`, a.auth);
        expect(hit.body.context.summary).toBe("Revised.");
        expect(hit.body.stats.entries).toBe(1);
      });

      it("requires authentication", async () => {
        const client = await makeClient();
        const { pairingId } = await pair(client, { mode: "cowork", repo: null });
        expect((await client.get(`/pairings/${pairingId}/context?path=a&sha=abcdef1`)).status).toBe(401);
        expect((await client.post(`/pairings/${pairingId}/context`, { context: ENTRY })).status).toBe(401);
      });

      it("requires both path and sha to read", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        expect((await client.get(`/pairings/${pairingId}/context?path=src/api.ts`, a.auth)).status).toBe(400);
        expect((await client.get(`/pairings/${pairingId}/context?sha=a1b2c3d`, a.auth)).status).toBe(400);
      });

      describe("rejects malformed entries identically", () => {
        const BAD: Array<[string, unknown]> = [
          ["a missing path", { sha: "a1b2c3d", summary: "x" }],
          ["an absolute path", { path: "/etc/passwd", sha: "a1b2c3d", summary: "x" }],
          ["a traversing path", { path: "../../.ssh/id_rsa", sha: "a1b2c3d", summary: "x" }],
          ["a non-hex sha", { path: "a.ts", sha: "not-a-sha", summary: "x" }],
          ["an empty summary", { path: "a.ts", sha: "a1b2c3d", summary: "" }],
          // A pasted file is exactly what the ledger exists to avoid paying for.
          ["a summary over the cap", { path: "a.ts", sha: "a1b2c3d", summary: "x".repeat(4001) }],
          ["a non-object entry", "src/api.ts"],
        ];

        for (const [why, context] of BAD) {
          it(`rejects ${why}`, async () => {
            const client = await makeClient();
            const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
            const res = await client.post(`/pairings/${pairingId}/context`, { context }, a.auth);
            expect(res.status).toBe(400);
          });
        }
      });
    });


    describe("capacity on presence (§8)", () => {
      const BASE = { branch: "inzo/7fk2q9", head: "a1b2c3d", dirty: [], ahead: 0, behind: 0, conflicted: false };
      const CAPACITY = {
        provider: "anthropic",
        windows: [
          { label: "5h", used: 0.62, resetsAt: "2026-09-01T15:40:00.000Z", estimated: true },
          { label: "weekly", used: 0.31, resetsAt: null, estimated: false },
        ],
      };

      it("carries capacity through on the presence beat, with no new endpoint", async () => {
        // The whole design point: capacity is a fast-changing per-member
        // liveness hint, which is exactly what presence already is. Zero new
        // protocol surface, zero storage, zero extra requests.
        const client = await makeClient();
        const { pairingId, a, b } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/presence`, { presence: { ...BASE, capacity: CAPACITY } }, a.auth);

        const seen = await client.get(`/pairings/${pairingId}/presence`, b.auth);
        expect(seen.body.presence[0].capacity.provider).toBe("anthropic");
        expect(seen.body.presence[0].capacity.windows).toHaveLength(2);
        expect(seen.body.presence[0].capacity.windows[0].used).toBe(0.62);
      });

      it("keeps a member who reports no windows quiet rather than guessing", async () => {
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        await client.post(`/pairings/${pairingId}/presence`, { presence: BASE }, a.auth);
        const seen = await client.get(`/pairings/${pairingId}/presence`, a.auth);
        // Null, never a zeroed window — a zero would read as "no quota left".
        expect(seen.body.presence[0].capacity ?? null).toBeNull();
      });

      it("preserves estimated:true, and defaults to it when unstated", async () => {
        // An estimate presented as fact is the failure mode worth preventing:
        // the window is per account, so a member also working solo is
        // undercounted by any self-reported number.
        const client = await makeClient();
        const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
        await client.post(
          `/pairings/${pairingId}/presence`,
          { presence: { ...BASE, capacity: { provider: "x", windows: [{ label: "5h", used: 0.5 }] } } },
          a.auth,
        );
        const seen = await client.get(`/pairings/${pairingId}/presence`, a.auth);
        expect(seen.body.presence[0].capacity.windows[0].estimated).toBe(true);
      });

      describe("rejects malformed capacity identically", () => {
        const BAD: Array<[string, unknown]> = [
          ["a missing provider", { windows: [] }],
          ["non-array windows", { provider: "x", windows: {} }],
          ["a used over 1", { provider: "x", windows: [{ label: "5h", used: 1.5 }] }],
          ["a negative used", { provider: "x", windows: [{ label: "5h", used: -0.1 }] }],
          ["a non-numeric used", { provider: "x", windows: [{ label: "5h", used: "62%" }] }],
          ["a missing label", { provider: "x", windows: [{ used: 0.5 }] }],
          ["an unparseable resetsAt", { provider: "x", windows: [{ label: "5h", used: 0.5, resetsAt: "soon" }] }],
          ["too many windows", { provider: "x", windows: Array.from({ length: 9 }, () => ({ label: "w", used: 0.1 })) }],
          ["a non-object capacity", "anthropic"],
        ];

        for (const [why, capacity] of BAD) {
          it(`rejects ${why}`, async () => {
            const client = await makeClient();
            const { pairingId, a } = await pair(client, { mode: "cowork", repo: null });
            const res = await client.post(`/pairings/${pairingId}/presence`, { presence: { ...BASE, capacity } }, a.auth);
            expect(res.status).toBe(400);
          });
        }
      });
    });


    describe("version negotiation (§9 U-3)", () => {
      it("advertises the minimum client version on create and on join", async () => {
        // A client learns it is too old at the entry point, before it acts,
        // rather than after it starts behaving strangely. Both relays must
        // say so — a client that trusts one and not the other is exactly the
        // silent disagreement this exists to prevent.
        const client = await makeClient();
        const created = await client.post("/pairings", {});
        expect(typeof created.body.minClientVersion).toBe("string");
        expect(created.body.protocolVersion).toBe(3);

        const joined = await client.post(`/pairings/${created.body.code}/join`, {});
        expect(joined.body.minClientVersion).toBe(created.body.minClientVersion);
        expect(joined.body.protocolVersion).toBe(3);
      });

      it("advertises a version this build's own client satisfies", async () => {
        // A relay whose minimum excludes the CLI shipped alongside it would
        // lock every user out on the first join.
        const client = await makeClient();
        const created = await client.post("/pairings", {});
        expect(created.body.minClientVersion).toMatch(/^\d+\.\d+\.\d+$/);
      });
    });

  });
}
