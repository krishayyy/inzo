/**
 * The CLI's own version.
 *
 * Its own module because `index.ts`, `doctor.ts`, and `start.ts` all need it,
 * and importing `index.ts` for a constant would run the whole CLI's
 * entrypoint. Kept in step with package.json by the release process.
 */
export const VERSION = "0.3.0";

/**
 * The MCP server version pinned into `.mcp.json` (§9 U-3).
 *
 * Pinned rather than floating so a session's agent and CLI are known to agree.
 * `inzo start` and `inzo join` rewrite an out-of-date pin, which is the fix for
 * the otherwise baffling failure where you update the CLI, everything looks
 * current, and your agent keeps running last month's server forever.
 */
export const MCP_VERSION = "0.3.0";
