// Shared domain types — single source of truth stays in packages/relay; this
// package re-exports rather than forking a second copy that can drift.
// PresenceEntry itself now lives in inzo-protocol (re-exported from there).
export * from "../../relay/src/types.js";
