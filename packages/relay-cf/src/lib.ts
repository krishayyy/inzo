// Pure protocol logic — crypto, capability narrowing, consent statements,
// error shapes. Zero SQL, zero framework coupling in the source files this
// re-exports, so it runs unchanged on Workers instead of being forked.
export * from "../../relay/src/lib/credential.js";
export * from "../../relay/src/lib/scopes.js";
export * from "../../relay/src/lib/consent.js";
export * from "../../relay/src/lib/errors.js";
export * from "../../relay/src/lib/ids.js";
export * from "../../relay/src/lib/runway.js";
// audit.ts's AuditLog class takes a `db` typed only as better-sqlite3's
// Database — a type-only import, erased at compile time — so the pure
// pieces (hashRecord, GENESIS_HASH, AUDIT_SCHEMA, types) port unchanged.
// relay-cf writes its own DO-storage-backed append/list/verify instead of
// instantiating AuditLog directly.
export * from "../../relay/src/lib/audit.js";
