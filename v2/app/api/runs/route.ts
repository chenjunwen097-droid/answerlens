import { getRuntime, type Brief } from "@/lib/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = (await request.json()) as { brief?: Brief; reportId?: string };
  if (!body.brief?.brand || !Array.isArray(body.brief.competitors)) {
    return Response.json({ error: "brief is required" }, { status: 400 });
  }

  const agent = getRuntime();
  const reportId = body.reportId || crypto.randomUUID();
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      try {
        for await (const event of agent.run({ brief: body.brief!, reportId })) {
          send(event);
        }
      } catch (error) {
        send({ type: "error", message: (error as Error).message, retryable: true });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
