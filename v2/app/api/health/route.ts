import { getRuntime } from "@/lib/runtime";
import { searchConfigured } from "@/lib/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const agent = getRuntime();
  return Response.json({
    ok: true,
    service: "answerlens-v2",
    checkedAt: new Date().toISOString(),
    runtime: agent.name,
    providers: {
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
      glm: Boolean(process.env.GLM_API_KEY),
      search: searchConfigured(),
      supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
    }
  });
}
