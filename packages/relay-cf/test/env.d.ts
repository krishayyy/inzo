import type { PairingRoom } from "../src/pairingRoom.js";
import type { Registry } from "../src/registry.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    REGISTRY: DurableObjectNamespace<Registry>;
    PAIRING_ROOM: DurableObjectNamespace<PairingRoom>;
    INZO_ADMIN_TOKEN?: string;
  }
}
