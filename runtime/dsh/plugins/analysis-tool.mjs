import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "answerlens-analysis-tool";
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "prepare_analysis",
      description:
        "当用户明确要求检测、对比或分析产品时，提取用户原话中已经出现的品牌和 1–3 个竞品。此工具只准备检测卡片，不会自动开始检测。",
      parameters: {
        brand: { type: "string", required: true, description: "用户自己的品牌，必须来自用户原话" },
        product: { type: "string", description: "用户明确说出的产品、型号或具体服务；未说则不填" },
        competitors: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "用户明确说出的 1–3 个竞品，每个都必须来自用户原话"
        },
        directions: {
          type: "array",
          items: { type: "string" },
          description: "用户明确要求的检测方向，例如屏幕体验、续航、价格或口感"
        },
        other: { type: "string", description: "用户补充但无法归入其他字段的要求；未说则不填" }
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: { type: "string", required: true },
            brief: {
              type: "object",
              required: true,
              additionalProperties: false,
              properties: {
                brand: { type: "string", required: true },
                product: { type: "string" },
                competitors: {
                  type: "array",
                  required: true,
                  items: { type: "string" }
                },
                directions: { type: "array", items: { type: "string" } },
                other: { type: "string" }
              }
            }
          }
        },
        render: (_args, value) => [
          {
            type: "text",
            text: `已准备检测卡片：${value.brief.brand}${
              value.brief.product ? ` · ${value.brief.product}` : ""
            } vs ${value.brief.competitors.join(" / ")}`
          }
        ]
      },
      timeoutMs: 2_000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const competitors = [...new Set(args.competitors.map((item) => item.trim()).filter(Boolean))].slice(
          0,
          3
        );
        if (!args.brand.trim() || competitors.length === 0) {
          throw new Error("品牌和至少一个竞品必填");
        }
        return {
          status: "awaiting-confirmation",
          brief: {
            brand: args.brand.trim(),
            ...(args.product?.trim() ? { product: args.product.trim() } : {}),
            competitors,
            directions: (args.directions || []).map((item) => item.trim()).filter(Boolean),
            ...(args.other?.trim() ? { other: args.other.trim() } : {})
          }
        };
      }
    })
  );
}
