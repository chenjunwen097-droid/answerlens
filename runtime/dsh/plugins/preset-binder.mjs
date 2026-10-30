import fs from "node:fs";

export const name = "answerlens-preset-binder";
export const inject = ["agentPresets"];

function debug(line) {
  if (process.env.ANSWERLENS_DSH_DEBUG_FILE) {
    fs.appendFileSync(process.env.ANSWERLENS_DSH_DEBUG_FILE, `${line}\n`);
  }
}

export function apply(ctx) {
  debug("binder loaded");
  ctx.on("agent/created", async ({ agent, signal }) => {
    debug(`agent created ${agent.id}`);
    signal?.throwIfAborted();
    const current = ctx.agentPresets.composedPreset(agent.ctx);
    debug(`current preset ${current || "none"}`);
    if (current) return;
    const requested = process.env.ANSWERLENS_ACTIVE_PRESET || ctx.agentPresets.defaultId;
    const mounted = await ctx.agentPresets.mount(agent.ctx, requested);
    debug(`mounted ${mounted.id}`);
  });
}
