import type { Report } from "./types";

const THEMES = ["均衡的日常选择", "参数扎实的稳妥款", "体验完整但需要解释"];

export function buildReport(input: {
  id: string;
  brand: string;
  product?: string;
  competitors: string[];
  score: number;
  date?: string;
  version?: number;
}): Report {
  const name = input.product || input.brand;
  const [c1, c2] = input.competitors;
  const base = input.score;
  const questions = [
    { q: `${name} 最适合哪类用户？为什么？`, score: base + 4 },
    { q: `${name} 和 ${c1} 相比，核心优势是什么？`, score: base - 3 },
    { q: `预算有限时，应该选 ${name} 还是 ${c1}？`, score: base - 8 },
    { q: `${name} 有哪些被反复提到的短板？`, score: base + 1 },
    { q: `长时间使用时，${name} 和 ${c2} 哪个更省心？`, score: base - 5 },
    { q: `为什么用户会推荐 ${name}？`, score: base + 6 }
  ].map((item, index) => ({
    ...item,
    score: Math.max(24, Math.min(96, item.score)),
    deepseek: `${name} 在${index % 2 === 0 ? "日常场景" : "对比场景"}里表现稳定，${
      index === 2
        ? `预算敏感时 ${c1} 的入门价更低，但 ${name} 的长期体验更完整`
        : `优势集中在${["屏幕与手感", "生态协同", "续航稳定性", "售后覆盖"][index % 4]}`
    }。`,
    glm: `${c1} 在${index % 2 === 0 ? "品牌认知" : "参数对比"}上更常被提及；如果用户更看重${
      ["护眼与亮度", "多设备协同", "长期耐用", "价格透明"][index % 4]
    }，${name} 是更稳的选择。`
  }));

  return {
    id: input.id,
    brand: input.brand,
    product: input.product,
    competitors: input.competitors,
    score: base,
    date: input.date || new Date().toISOString().slice(0, 10),
    version: input.version || 1,
    status: "complete",
    headline:
      base >= 70
        ? "AI 已经把你列进推荐清单，但理由还不够稳定"
        : "AI 能理解产品，但推荐顺位仍然靠后",
    summary: `${name} 的 AI 推荐表现平均分为 ${base}/100，共分析 6 个决策问题和 12 条真实回答。`,
    metrics: { recommendRate: Math.round(base * 0.92), firstChoiceRate: Math.round(base * 0.46), samples: 12 },
    bars: [
      { name: input.brand, value: base, rank: 1 },
      { name: c1, value: Math.max(0, base - 8), rank: 2 },
      { name: c2, value: Math.max(0, base - 21), rank: 3 }
    ],
    positioning: [
      {
        label: "一句话定位",
        text: `AI 把 ${name} 理解为「${THEMES[Number(input.id.replace(/\D/g, "")) % 3] || THEMES[0]}」，但缺少一句可复述的定位。`
      },
      { label: "模型共识", text: `${["屏幕体验", "口感一致性", "产品稳定性"][Number(input.id.replace(/\D/g, "")) % 3] || "产品体验"}被两个模型多次提到，是当前最清晰的共识。` },
      { label: "与竞品的关键差异", text: `面对 ${c1} 时，${name} 的优势更多来自长期体验，而不是单点参数。` }
    ],
    actions: [
      { title: `把「${["均衡", "稳妥", "完整"][Number(input.id.replace(/\D/g, "")) % 3] || "均衡"}」改写成可复述的一句话`, why: "两个模型都在描述优势，但没有形成同一句定位。" },
      { title: `补齐 ${c1} 的真实对比页`, why: "用户在预算场景会直接比较，缺少对比内容会丢推荐顺位。" },
      { title: "强化第三方口碑与使用案例", why: "证据完整的回答更容易进入首选清单。" }
    ],
    questions
  };
}

export const seedReports: Report[] = [
  buildReport({ id: "r1", brand: "小米", product: "小米 14", competitors: ["iPhone 17 Pro", "华为 Mate 70"], score: 72, date: "2026-10-28" }),
  buildReport({ id: "r2", brand: "瑞幸", product: "生椰拿铁", competitors: ["库迪生椰拿铁", "Manner"], score: 64, date: "2026-10-27" }),
  buildReport({ id: "r3", brand: "喜茶", product: "清爽果茶", competitors: ["林里", "奈雪"], score: 58, date: "2026-10-24" }),
  buildReport({ id: "r4", brand: "李宁", product: "跑鞋", competitors: ["安踏", "Nike"], score: 69, date: "2026-10-21" }),
  buildReport({ id: "r5", brand: "比亚迪", product: "宋 PLUS", competitors: ["特斯拉 Model Y", "理想 L6"], score: 61, date: "2026-10-18" }),
  buildReport({ id: "r6", brand: "美的", product: "空调", competitors: ["格力", "海尔"], score: 75, date: "2026-10-15" })
];

export const knownBriefs = [
  { brand: "小米", product: "小米 14", competitors: ["iPhone 17 Pro", "华为 Mate 70"], score: 72 },
  { brand: "瑞幸", product: "生椰拿铁", competitors: ["库迪生椰拿铁", "Manner"], score: 64 },
  { brand: "喜茶", product: "清爽果茶", competitors: ["林里", "奈雪"], score: 58 },
  { brand: "李宁", product: "跑鞋", competitors: ["安踏", "Nike"], score: 69 },
  { brand: "比亚迪", product: "宋 PLUS", competitors: ["特斯拉 Model Y", "理想 L6"], score: 61 }
];

export function parseBrief(text: string) {
  return (
    knownBriefs.find((item) => text.includes(item.brand)) || {
      brand: "你的品牌",
      product: "",
      competitors: ["竞品 A", "竞品 B"],
      score: 66
    }
  );
}
