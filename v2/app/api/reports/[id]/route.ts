import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const reports = await getRuntime().listReports();
    const report = reports.find((item) => item.id === id);
    if (!report) return Response.json({ error: "report not found" }, { status: 404 });
    return Response.json({ report });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 502 });
  }
}
