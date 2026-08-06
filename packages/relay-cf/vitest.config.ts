import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        // Test-only stand-in for the INZO_ADMIN_TOKEN secret (set for real
        // via `wrangler secret put` — never committed, never in
        // wrangler.jsonc). Tests need SOME value to exercise the gated
        // /admin/rotate-key route against.
        miniflare: {
          bindings: { INZO_ADMIN_TOKEN: "test-admin-token" },
        },
      },
    },
  },
});
