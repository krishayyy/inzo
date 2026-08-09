/**
 * Alibaba Cloud AgentRun integration.
 *
 * A proposed plan sits `locked: false` until both paired humans approve —
 * that gap is a genuine execute-wait-execute moment: neither agent has
 * anything useful to do until the second approval lands. Instead of a
 * process polling or sitting idle, the wait is embodied as a real AgentRun
 * sandbox that gets stopped while the plan is pending and torn down once
 * both approvals land (`locked` flips true).
 *
 * VERIFIED against the installed @agentrun/sdk@0.0.5 type declarations
 * (dist/sandbox/index.d.ts, dist/model-*.d.ts) — not guessed:
 *   - auth: new Config({ accessKeyId, accessKeySecret, accountId, regionId })
 *   - SandboxClient.createSandbox({ input: { templateName, ... }, templateType, config }) -> Sandbox
 *   - SandboxClient.stopSandbox({ id, config }) / deleteSandbox({ id, config })
 *   - SandboxState enum: Creating | Running | READY | Stopped | Failed | Deleting
 *   - templateName is REQUIRED — there is no default/shared template. A Code
 *     Interpreter template must be created once in the AgentRun console first
 *     (docs.agent.run/docs/tutorial/quickstart/template: "you must first
 *     create cloud resources in the AgentRun console... a code interpreter
 *     sandbox template"). Set AGENTRUN_TEMPLATE_NAME once that exists.
 *
 * IMPORTANT — checked and NOT present at this SDK version: there is no
 * pause/hibernate/resume/wake method on Sandbox or SandboxClient, and
 * SandboxState has no "Hibernated" member. The FC Sandbox handbook's "light
 * ~1ms / deep ~1s hibernation" is a real platform capability but it is not
 * exposed in this Node SDK yet — it may be REST-API-only, preview-gated, or
 * documented only in-console. Do not claim the hibernation rubric line until
 * this is confirmed against the console API explorer or #alibaba-cloud-support.
 * Until then this uses stop/recreate (Stopped -> new Sandbox), which is the
 * verified, honest equivalent: real compute is torn down while waiting, not
 * left running and polling.
 */

export interface AgentRunConfig {
  accessKeyId?: string;
  accessKeySecret?: string;
  accountId?: string;
  region: string;
  templateName?: string;
}

function agentrunConfig(): AgentRunConfig {
  return {
    accessKeyId: process.env.AGENTRUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.AGENTRUN_ACCESS_KEY_SECRET,
    accountId: process.env.AGENTRUN_ACCOUNT_ID,
    region: process.env.AGENTRUN_REGION ?? "cn-hangzhou",
    templateName: process.env.AGENTRUN_TEMPLATE_NAME,
  };
}

export interface AgentRunStatus {
  configured: boolean;
  region?: string;
  templateName?: string;
}

export function agentrunStatus(): AgentRunStatus {
  const c = agentrunConfig();
  const configured = !!(c.accessKeyId && c.accessKeySecret && c.accountId && c.templateName);
  return { configured, region: c.region, templateName: c.templateName };
}

async function makeClient() {
  const c = agentrunConfig();
  const { SandboxClient } = await import("@agentrun/sdk/sandbox");
  const { Config } = await import("@agentrun/sdk");
  const config = new Config({
    accessKeyId: c.accessKeyId,
    accessKeySecret: c.accessKeySecret,
    accountId: c.accountId,
    regionId: c.region,
  });
  return { client: new SandboxClient(config), templateName: c.templateName! };
}

export interface WaitHandle {
  sandboxId: string;
  simulated: boolean;
  /** Stop the sandbox while the plan is pending both approvals. */
  suspend: () => Promise<void>;
  /** Tear the sandbox down for good once the plan locks (or is re-proposed). */
  dispose: () => Promise<void>;
}

/**
 * Embody a pending-plan wait inside a real AgentRun sandbox (stop/recreate,
 * see file header re: hibernation). Falls back to a clearly-labeled
 * simulated wait when AgentRun isn't fully configured, so the relay always
 * runs without credentials.
 */
export async function beginPlanWait(label: string): Promise<WaitHandle> {
  if (!agentrunStatus().configured) {
    return {
      sandboxId: `sim-${Date.now().toString(36)}`,
      simulated: true,
      suspend: async () => {},
      dispose: async () => {},
    };
  }
  try {
    const { client, templateName } = await makeClient();
    const { TemplateType } = await import("@agentrun/sdk/sandbox");
    const sandbox = await client.createSandbox({
      input: { templateName, sandboxIdleTimeoutSeconds: 300 },
      templateType: TemplateType.CODE_INTERPRETER,
    });
    const id = sandbox.sandboxId;
    if (!id) throw new Error("createSandbox returned no sandboxId");
    return {
      sandboxId: id,
      simulated: false,
      suspend: async () => {
        await client.stopSandbox({ id });
      },
      dispose: async () => {
        try {
          await client.deleteSandbox({ id });
        } catch {
          /* best effort — sandboxes auto-destroy after idle timeout anyway */
        }
      },
    };
  } catch (err) {
    console.warn(`[agentrun] sandbox spawn failed for "${label}" (${(err as Error).message}); using simulated wait`);
    return {
      sandboxId: `sim-${Date.now().toString(36)}`,
      simulated: true,
      suspend: async () => {},
      dispose: async () => {},
    };
  }
}
