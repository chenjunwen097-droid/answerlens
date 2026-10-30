import { getRuntime } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const reports = await getRuntime().listReports();
    return Response.json({ reports });
  } catch (error) {
    return Response.json(
      { error: `报告库暂时不可用：${(error as Error).message}`, reports: [] },
      { status: 502 }
    );
  }
}
