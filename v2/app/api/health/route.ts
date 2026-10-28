import { getRuntime } from "@/lib/runtime";
import { searchConfigured } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const agent = getRuntime();
  let remote: Record<string, unknown> | null = null;
  if (process.env.AGENT_RUNTIME_URL) {
    try {
      const response = await fetch(`${process.env.AGENT_RUNTIME_URL}/health`, {
        signal: AbortSignal.timeout(5_000),
        cache: "no-store"
      });
      if (response.ok) remote = (await response.json()) as Record<string, unknown>;
    } catch {
      remote = { ok: false, error: "runtime unreachable" };
    }
  }
  const remoteModels = (remote?.models || {}) as Record<string, boolean>;
  return Response.json({
    ok: true,
    service: "answerlens-v2",
    checkedAt: new Date().toISOString(),
    runtime: agent.name,
    providers: process.env.AGENT_RUNTIME_URL
      ? {
          deepseek: Boolean(remoteModels.deepseek),
          glm: Boolean(remoteModels.glm),
          search: Boolean(remoteModels.search),
          supabase: Boolean(
            process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
          )
        }
      : {
          deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
          glm: Boolean(process.env.GLM_API_KEY),
          search: searchConfigured(),
          supabase: Boolean(
            process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY
          )
        },
    remote
  });
}
