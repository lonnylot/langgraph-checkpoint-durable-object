import type { CheckpointHarness } from "./harness.js";

declare global {
  namespace Cloudflare {
    interface Env {
      CHECKPOINT: DurableObjectNamespace<CheckpointHarness>;
    }
  }
}
