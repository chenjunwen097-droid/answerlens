(function (root, factory) {
  const core = factory();
  if (typeof module === "object" && module.exports) module.exports = core;
  root.VisibilityCore = core;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const OFF_TOPIC = [
    "红烧鱼",
    "怎么做饭",
    "天气",
    "股票",
    "游戏攻略",
    "新闻"
  ];

  const SCORE_DIMENSIONS = [
    {
      key: "presence",
      label: "推荐出现",
      weight: 25,
      description: "AI 是否主动提及产品",
      rule:
        "按“是否提到名称、是否给出评价、是否列入推荐清单、是否被列为首选、是否被否定”五项逐条判定",
      formula: "(提到 ×1 + 给出评价 ×1 + 列入推荐 ×1 + 被列为首选 ×1 − 被否定 ×2) ÷ 4 × 100",
      values: ["0", "25", "50", "75", "100"]
    },
    {
      key: "rank",
      label: "推荐顺位",
      weight: 25,
      description: "产品在候选方案中的推荐位置",
      rule: "按回答给出的推荐名次计分；回答没有给出顺序时，本题不参与该项",
      formula: "第 1 名 = 100，之后每降一名 −25",
      values: ["25", "50", "75", "100"]
    },
    {
      key: "sentiment",
      label: "描述倾向",
      weight: 15,
      description: "AI 对产品描述的正负倾向",
      rule: "按回答对该产品的整体描述倾向判定，混合指同时有明显优点和缺点",
      formula: "正面 = 100，中立 = 60，混合 = 40，负面 = 20",
      values: ["20", "40", "60", "100"]
    },
    {
      key: "evidence",
      label: "证据完整",
      weight: 20,
      description: "回答是否有具体且可验证的依据",
      rule:
        "把回答里的事实主张逐条拆开：“具体”指含参数、数字、场景、时间或来源，“笼统”指只有形容词或结论；对同一个产品的重复说法只算一条",
      formula: "具体主张数 ÷（具体主张数 + 笼统主张数）× 100",
      values: ["0", "50", "67", "100"],
      valuesNote: "回答全是主观推荐、没有事实主张时，本题不参与该项"
    },
    {
      key: "differentiation",
      label: "竞品差异",
      weight: 15,
      description: "回答是否说明产品与竞品的差异",
      rule: "按“显式比较竞品、指出相对差异点、给出选择条件”三项逐条判定，本题没问到其他产品时该项不参与",
      formula: "(显式比较 ×1 + 指出相对差异点 ×1 + 给出选择条件 ×1) ÷ 3 × 100",
      values: ["0", "33", "67", "100"]
    }
  ];

  function cleanList(items) {
    const seen = new Set();
    return (items || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 3);
  }

  function cleanValues(items, limit) {
    const seen = new Set();
    return (items || [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .filter((item) => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit);
  }

  function cleanBrief(input = {}) {
    const source = input && typeof input === "object" ? input : {};
    const competitors = (Array.isArray(source.competitors) ? source.competitors : [])
      .map((item) =>
        typeof item === "string"
          ? { name: item.trim(), product: "" }
          : {
              name: String(item?.name || "").trim(),
              product: String(item?.product || "").trim()
            }
      )
      .filter((item) => item.name)
      .filter((item, index, items) =>
        items.findIndex(
          (candidate) => candidate.name.toLowerCase() === item.name.toLowerCase()
        ) === index
      )
      .slice(0, 3);
    return {
      brand: String(source.brand || "").trim().slice(0, 100),
      brandProduct: String(source.brandProduct || "").trim().slice(0, 100),
      competitors,
      dimensions: cleanValues(
        Array.isArray(source.dimensions) ? source.dimensions : [],
        6
      ).map((item) => item.slice(0, 60)),
      other: String(source.other || "").trim().slice(0, 1000)
    };
  }

  function isOffTopic(input) {
    const value = String(input || "").trim().toLowerCase();
    return OFF_TOPIC.some((term) => value.includes(term));
  }

  function makeQuestions(brand, competitors) {
    const names = cleanList(competitors);
    const alternatives = names.length ? names.join("、") : "同类产品";
    return [
      `${brand} 适合哪些团队，和 ${alternatives} 有什么区别？`,
      `${brand} 和 ${alternatives} 相比，有哪些可靠的替代品？`,
      `预算有限时应该选 ${brand} 还是 ${alternatives}？`,
      `${brand} 的核心优势和主要短板是什么？`,
      `长期使用时，${brand} 和 ${alternatives} 哪个更值得选？`,
      `用户为什么推荐或不推荐 ${brand}？`
    ];
  }

  function makeQuestionsForBrief(brief) {
    const normalized = cleanBrief(brief);
    // "小米 14" already contains the brand, so avoid "小米 小米 14".
    const primary = !normalized.brandProduct
      ? normalized.brand
      : normalized.brandProduct
          .toLowerCase()
          .includes(String(normalized.brand || "").toLowerCase())
        ? normalized.brandProduct
        : `${normalized.brand} ${normalized.brandProduct}`;
    const competitorNames = normalized.competitors
      .map((item) => (item.product ? `${item.name} ${item.product}` : item.name))
      .join("、");
    const alternatives = competitorNames || "同类产品";
    const dimensions = normalized.dimensions.length
      ? normalized.dimensions
      : ["核心体验", "价格", "口碑"];
    return [
      `${primary} 适合哪些用户，和 ${alternatives} 相比有什么差异？`,
      dimensions[0]
        ? `${primary} 在${dimensions[0]}方面的真实体验如何，和 ${alternatives} 相比谁更好？`
        : `${primary} 有哪些可靠的替代品，相比 ${alternatives} 如何？`,
      dimensions[1]
        ? `关注${dimensions[1]}时，应该选择 ${primary} 还是 ${alternatives}？`
        : `预算有限时应该选 ${primary} 还是 ${alternatives}？`,
      `${primary} 的核心优势和主要短板是什么？`,
      dimensions[2]
        ? `${dimensions[2]}是否会明显影响 ${primary} 和 ${alternatives} 的长期使用体验？`
        : `长期使用时，${primary} 和 ${alternatives} 哪个更值得选？`,
      `用户为什么推荐或不推荐 ${primary}？`
    ];
  }

  function scoreFor(brand) {
    if (String(brand || "").trim().toLowerCase() === "notion") return 58;
    const base = [...String(brand || "")].reduce(
      (sum, char) => (sum + char.charCodeAt(0)) % 17,
      0
    );
    return 52 + base;
  }

  function buildReport(brand, competitors) {
    const names = cleanList(competitors);
    const score = scoreFor(brand);
    const mentioned = Math.max(3, Math.min(6, Math.round(score / 16)));
    const alternatives = names.length ? names.join("、") : "同类产品";
    const questions = makeQuestions(brand, names);
    const mentionedIndexes = new Set([0, 2, 3, 5].slice(0, mentioned));
    const mockQuestionScores = [70, 45, 55, 50, 65, 63];
    // Mock coverage mirrors the real rules: the brand is asked everywhere, and
    // each competitor is asked in four questions so it can be scored.
    const competitorAsked = [
      [0, 1, 2, 4],
      [0, 1, 2, 4],
      [0, 1, 2, 4]
    ];
    const competitorScores = [52, 0, 61];
    const competitorIds = names.map((_, index) => `competitor_${index + 1}`);
    const questionStats = questions.map((question, index) => {
      const asked = mentionedIndexes.has(index);
      const dimensions = {
        presence: asked ? 100 : 0,
        rank: asked ? 70 : 0,
        sentiment: asked ? 60 : 0,
        evidence: asked ? 70 : 0,
        differentiation: asked ? 50 : 0
      };
      const entityScores = {
        brand: {
          asked: true,
          applicable: true,
          mentioned: asked,
          mentions: asked ? 1 : 0,
          score: mockQuestionScores[index],
          ...dimensions,
          dimensions: { ...dimensions, score: mockQuestionScores[index] }
        }
      };
      competitorIds.forEach((id, position) => {
        const isAsked = (competitorAsked[position] || []).includes(index);
        if (!isAsked) {
          entityScores[id] = {
            asked: false,
            applicable: false,
            mentioned: false,
            mentions: 0,
            score: null,
            dimensions: null
          };
          return;
        }
        const value = competitorScores[position] ?? 50;
        const named = value > 0;
        const competitorDimensions = {
          presence: named ? 100 : 0,
          rank: named ? 60 : 0,
          sentiment: named ? 60 : 0,
          evidence: named ? 70 : 0,
          differentiation: named ? 60 : 0
        };
        entityScores[id] = {
          asked: true,
          applicable: true,
          mentioned: named,
          mentions: named ? 1 : 0,
          score: value,
          ...competitorDimensions,
          dimensions: { ...competitorDimensions, score: value }
        };
      });
      return {
        questionIndex: index,
        question,
        mentioned: asked,
        mentions: asked ? 1 : 0,
        sentiment: index % 3 === 0 ? "neutral" : "positive",
        score: mockQuestionScores[index],
        dimensions,
        entityScores,
        askedEntityIds: [
          "brand",
          ...competitorIds.filter((_, position) =>
            (competitorAsked[position] || []).includes(index)
          )
        ]
      };
    });
    const buildEntityStat = (id, type, name) => {
      const perQuestion = questionStats
        .map((stat) => stat.entityScores[id])
        .filter((item) => item?.applicable);
      const askedQuestions = perQuestion.length;
      const insufficient = askedQuestions < MIN_ASKED_QUESTIONS;
      const rankable = askedQuestions >= RANKING_MIN_QUESTIONS;
      const average = askedQuestions
        ? Math.round(
            perQuestion.reduce((sum, item) => sum + item.score, 0) / askedQuestions
          )
        : null;
      return {
        id,
        type,
        name,
        askedQuestions,
        totalQuestions: 6,
        insufficient,
        rankable,
        score: insufficient ? null : average,
        rawScore: average,
        mentions: perQuestion.filter((item) => item.mentioned).length,
        askedAnswers: askedQuestions * 2
      };
    };
    const entityStats = [
      buildEntityStat("brand", "brand", String(brand || "").trim()),
      ...competitorIds.map((id, index) =>
        buildEntityStat(id, "competitor", names[index])
      )
    ];
    const ranking = entityStats
      .filter((item) => item.rankable && item.score !== null)
      .sort((a, b) => b.score - a.score)
      .map((item, index) => ({
        id: item.id,
        name: item.name,
        rank: index + 1,
        score: item.score
      }));
    return {
      brand: String(brand || "").trim(),
      competitors: names,
      score,
      mentioned,
      totalQuestions: 6,
      sentiment: Math.min(88, score + 10),
      rank: score >= 65 ? 2 : 3,
      questions,
      questionStats,
      entityStats,
      ranking,
      minAskedQuestions: MIN_ASKED_QUESTIONS,
      rankingMinQuestions: RANKING_MIN_QUESTIONS,
      matrix: entityStats.map((item) => ({
        id: item.id,
        type: item.type,
        name: item.name,
        value: item.score,
        mentions: item.mentions,
        asked: item.askedQuestions,
        insufficient: item.insufficient,
        rankable: item.rankable
      })),
      positioning: {
        headline: `AI 把 ${brand} 理解成“全能工作区”，但缺少一句可复述的定位。`,
        consensus: "灵活的协作与知识管理能力被两个模型多次提到。",
        differentiators: `面对单一任务时，${alternatives} 更常成为首选答案，差异没有拉开。`,
        conflicts: [
          {
            entityName: brand,
            question: "它在大型团队里的适用性如何？",
            summary: "",
            sides: [
              {
                provider: "deepseek",
                model: "deepseek-flash",
                quote: `${brand} 在大型团队里更依赖流程治理。`
              },
              {
                provider: "glm",
                model: "glm-4.6v",
                quote: `${brand} 在大团队中反而更容易落地。`
              }
            ]
          }
        ]
      },
      suggestions: [
        {
          title: "把“全能工作区”改写成一个可复述的定位",
          detail: "用一句话说明适合谁、解决什么问题，以及为何优于垂直工具。",
          impact: "高影响"
        },
        {
          title: "补齐三组真实选型对比页",
          detail: "围绕预算、团队规模和迁移成本回答买家最常比较的问题。",
          impact: "中高影响"
        },
        {
          title: "强化第三方口碑与使用案例",
          detail: "让可信来源更容易引用你的产品，并给出具体结果和适用边界。",
          impact: "中高影响"
        }
      ],
      modelStats: [
        { name: "DeepSeek", state: "稳定", answers: 6, mentions: Math.ceil(mentioned / 2) },
        { name: "GLM", state: "稳定", answers: 6, mentions: Math.floor(mentioned / 2) }
      ],
      metrics: {
        mentionRate: Math.round((mentioned / 6) * 100),
        // The local preview mirrors the real metric: the share of answers the
        // model actually recommended, not just mentioned.
        recommendationRate: Math.max(17, Math.round((mentioned / 6) * 100) - 33),
        firstChoiceRate: Math.max(17, Math.round((mentioned / 6) * 100) - 50),
        judgedAnswers: 12,
        averageRank: score >= 65 ? 2 : 3,
        positiveRate: Math.min(88, score + 10),
        evidenceRate: 60,
        averageQuestionScore: score
      },
      scoringStandard: SCORE_DIMENSIONS,
      isReal: false
    };
  }

  function timelineFor(report) {
    return [
      {
        id: "questions",
        label: "提交 6 个已确认买家问题",
        detail: "已使用用户确认的选型、替代品、预算和口碑问题"
      },
      {
        id: "deepseek",
        label: `询问 DeepSeek Flash · 6/6`,
        detail: `第 4 个问题发现 ${report.competitors[0] || "竞品"} 被优先提及`
      },
      {
        id: "glm",
        label: `询问 GLM 4.6v · 6/6`,
        detail: `${report.brand} 在选型问题中被提及 ${report.mentioned} 次`
      },
      {
        id: "judge",
        label: report.judge
          ? `按判定项核对 ${report.judge.judgedAnswers}/${report.judge.totalAnswers} 条回答`
          : "按判定项核对回答",
        detail: report.judge
          ? "每条得分都能追溯到回答原文"
          : "等待回答完成"
      },
      {
        id: "extract",
        label: "提取推荐证据与产品理解",
        detail: "已从两个 AI 的回答中提取产品理解与推荐差异"
      },
      {
        id: "score",
        label: `生成 AI 推荐表现 ${report.score}/100`,
        detail: "由 6 个决策问题的推荐表现平均计算"
      }
    ];
  }

  function formatScore(score) {
    return String(Math.max(0, Math.min(100, Number(score) || 0)));
  }

  const MIN_COMPETITOR_COVERAGE = 3;
  const MIN_ASKED_QUESTIONS = 2;
  const RANKING_MIN_QUESTIONS = 3;

  function compactText(value) {
    return String(value || "")
      .replace(/\s+/g, "")
      .toLowerCase();
  }

  function brandKeys(brief) {
    const source = brief || {};
    return [
      source.brandProduct ? `${source.brand} ${source.brandProduct}` : "",
      source.brand,
      source.brandProduct
    ]
      .filter((item) => item && item.length >= 2)
      .map(compactText);
  }

  function competitorKeyList(brief) {
    return ((brief || {}).competitors || [])
      .map((item, index) => ({
        index,
        name: String(item?.name || "").trim(),
        keys: [
          item?.product ? `${item.name} ${item.product}` : "",
          item?.name || "",
          item?.product || ""
        ]
          .filter((value) => value && value.length >= 2)
          .map(compactText)
      }))
      .filter((item) => item.keys.length);
  }

  // Rules shared by the generator and the editor: every question must compare
  // the brand against at least one competitor, and every competitor needs
  // enough coverage to be scored fairly.
  // The six questions are generated from a fixed recipe: without quotas the
  // model happily writes six versions of the same question (all about price,
  // for example, because price was one of the checked directions).
  const QUESTION_RECIPE = [
    { key: "compare", label: "精简对比", count: 2 },
    { key: "scenario", label: "真实场景", count: 2 },
    { key: "stage", label: "决策阶段", count: 1 },
    { key: "ranking", label: "让 AI 排序", count: 1 }
  ];

  // A "scenario" question puts the buyer in a situation. Bare price adjectives
  // such as 划算 or 便宜 do not count: they are the plain comparison the recipe
  // already covers.
  const SCENE_DIMENSIONS = [
    {
      key: "people",
      label: "人群",
      pattern: /学生|上班族|白领|宝妈|家长|带娃|带孩子|老人|情侣|两个人|一个人|健身|减脂|加班/
    },
    {
      key: "time",
      label: "时间场合",
      pattern: /早餐|午餐|晚餐|下午茶|宵夜|夜宵|周末|工作日|聚会|节日|早上|晚上|深夜/
    },
    {
      key: "budget",
      label: "预算",
      pattern: /预算|\d+\s*(元|块|钱)|人均\s*\d/
    },
    {
      key: "place",
      label: "地点与等待",
      pattern: /外卖|堂食|到家|公司|宿舍|学校|路上|附近|排队|等待|出餐|距离/
    },
    {
      key: "health",
      label: "健康忌口",
      pattern: /健康|热量|卡路里|油|糖|忌口|过敏|素食|清淡/
    },
    {
      key: "stage",
      label: "决策阶段",
      pattern: /第一次|初次|换品牌|替代|复购|回购|长期|一直用|送礼|推荐给|新手/
    }
  ];

  function questionSceneKeys(text) {
    const value = String(text || "");
    return SCENE_DIMENSIONS.filter((item) => item.pattern.test(value)).map((item) => item.key);
  }

  // A checked direction is a coverage requirement, not the wording of every
  // question. "价格与性价比" is allowed in up to three of the six questions.
  function directionTokens(dimension) {
    const value = String(dimension || "").trim();
    if (!value) return [];
    const parts = value
      .split(/[与和及、/／,，\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2);
    return parts.length ? parts : [value];
  }

  const MAX_DIRECTION_QUESTIONS = 3;
  const MAX_SCENE_REPEAT = 2;

  // Batch-level quality rules. They are advisory: a batch that still fails them
  // is repaired once, then accepted as-is, because question generation must
  // never fail a whole report.
  function questionBatchProblems(texts, brief) {
    const list = (Array.isArray(texts) ? texts : []).map((text) => String(text || ""));
    const issues = [];
    const rewrite = new Set();
    if (list.length < 4) return { issues, rewriteIndexes: [] };

    const sceneHits = list.map((text) => questionSceneKeys(text));
    const scenarioCount = sceneHits.filter((keys) => keys.length).length;
    if (scenarioCount < 2) {
      issues.push(`scenario_shortage:${scenarioCount}`);
      // The shortest questions are the ones most likely to be a plain
      // restatement of the same comparison.
      list
        .map((text, index) => ({ index, length: compactText(text).length }))
        .sort((a, b) => a.length - b.length || a.index - b.index)
        .slice(0, 2)
        .forEach((item) => rewrite.add(item.index));
    }

    const byScene = {};
    sceneHits.forEach((keys, index) => {
      keys.forEach((key) => {
        byScene[key] = byScene[key] || [];
        byScene[key].push(index);
      });
    });
    Object.entries(byScene).forEach(([key, indexes]) => {
      if (indexes.length <= MAX_SCENE_REPEAT) return;
      issues.push(`scene_repeat:${key}:${indexes.length}`);
      indexes.slice(MAX_SCENE_REPEAT).forEach((index) => rewrite.add(index));
    });

    const byOpening = {};
    list.forEach((text, index) => {
      const opening = compactText(text).slice(0, 8);
      if (opening.length < 6) return;
      byOpening[opening] = byOpening[opening] || [];
      byOpening[opening].push(index);
    });
    Object.entries(byOpening).forEach(([, indexes]) => {
      if (indexes.length <= 2) return;
      issues.push(`same_opening:${indexes.length}`);
      indexes.slice(2).forEach((index) => rewrite.add(index));
    });

    (brief?.dimensions || []).forEach((dimension) => {
      directionTokens(dimension).forEach((token) => {
        const hits = list
          .map((text, index) => (text.includes(token) ? index : -1))
          .filter((index) => index >= 0);
        if (hits.length <= MAX_DIRECTION_QUESTIONS) return;
        issues.push(`direction_repeat:${token}:${hits.length}`);
        hits.slice(MAX_DIRECTION_QUESTIONS).forEach((index) => rewrite.add(index));
      });
    });

    return {
      issues,
      rewriteIndexes: [...rewrite].sort((a, b) => a - b).slice(0, 3)
    };
  }

  function questionProblems(text, brief) {
    const key = compactText(text);
    const problems = [];
    if (!key) return ["empty"];
    if (!brandKeys(brief).some((item) => key.includes(item))) {
      problems.push("missing_brand");
    }
    if (
      !competitorKeyList(brief).some((item) =>
        item.keys.some((candidate) => key.includes(candidate))
      )
    ) {
      problems.push("missing_competitor");
    }
    return problems;
  }

  function questionCoverage(brief, questions) {
    const list = Array.isArray(questions) ? questions : [];
    const countIn = (keys) =>
      list.filter((text) => keys.some((key) => compactText(text).includes(key))).length;
    const entities = [
      {
        id: "brand",
        type: "brand",
        name: (brief || {}).brand || "你的品牌",
        count: countIn(brandKeys(brief))
      },
      ...competitorKeyList(brief).map((item) => ({
        id: `competitor_${item.index + 1}`,
        type: "competitor",
        name: item.name,
        count: countIn(item.keys)
      }))
    ];
    return {
      total: list.length,
      minCompetitorCoverage: MIN_COMPETITOR_COVERAGE,
      entities,
      issues: list.map((text, index) => ({
        index,
        problems: questionProblems(text, brief)
      }))
    };
  }

  // --- conversations -------------------------------------------------------
  // A conversation is the unit the Copilot remember: its own messages, its own
  // report snapshot. Generating questions or running an analysis must never
  // clear it — only the user creates, switches or deletes conversations.
  const CONVERSATION_SCHEMA = 1;
  const CONVERSATION_LIMIT = 12;
  const CONVERSATION_MESSAGE_LIMIT = 50;
  const CONVERSATION_TITLE_LIMIT = 18;

  function newConversationId(seed) {
    const base = Number(seed) || Date.now();
    return `c_${base.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  function conversationTitleFrom(text, fallback = "新对话") {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return fallback;
    return value.length > CONVERSATION_TITLE_LIMIT
      ? `${value.slice(0, CONVERSATION_TITLE_LIMIT)}…`
      : value;
  }

  function createConversation({ id, at, title } = {}) {
    const createdAt = String(at || new Date().toISOString());
    return {
      id: String(id || newConversationId(Date.parse(createdAt))),
      title: String(title || "新对话").trim().slice(0, 40) || "新对话",
      createdAt,
      updatedAt: createdAt,
      pinned: false,
      messages: [],
      report: null
    };
  }

  // Keep the newest messages, and never let a history start with an assistant
  // reply: it would read as an answer to nothing.
  function trimConversationMessages(messages) {
    const list = Array.isArray(messages) ? messages : [];
    if (list.length <= CONVERSATION_MESSAGE_LIMIT) return list;
    let trimmed = list.slice(list.length - CONVERSATION_MESSAGE_LIMIT);
    while (trimmed.length && trimmed[0].role !== "user") trimmed = trimmed.slice(1);
    return trimmed;
  }

  function appendConversationMessage(conversation, message = {}) {
    const at = String(message.at || new Date().toISOString());
    const role = message.role === "user" ? "user" : "assistant";
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    const next = {
      ...(conversation || createConversation()),
      messages: [
        ...messages,
        {
          id: String(message.id || `m_${Date.parse(at) || Date.now()}_${messages.length + 1}`),
          role,
          text: String(message.text || "").slice(0, 4000),
          blocks: Array.isArray(message.blocks) ? message.blocks : [],
          at
        }
      ],
      updatedAt: at
    };
    // The first user message names the conversation.
    if (role === "user" && messages.length === 0) {
      next.title = conversationTitleFrom(message.text);
    }
    next.messages = trimConversationMessages(next.messages);
    return next;
  }

  function sortConversations(list) {
    return [...(list || [])].sort(
      (a, b) =>
        // Pinned conversations float to the top; everything else is newest first.
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
    );
  }

  // Eviction prefers dropping the least recently used conversation, but never
  // the one we were just asked to keep (a brand-new conversation while every
  // slot is pinned).
  function pruneConversations(list, limit = CONVERSATION_LIMIT, keepId = null) {
    const ordered = sortConversations(list);
    const kept = ordered.slice(0, limit);
    if (keepId && !kept.some((item) => item.id === keepId)) {
      const wanted = ordered.find((item) => item.id === keepId);
      if (wanted) kept[kept.length - 1] = wanted;
    }
    return kept;
  }

  function pinConversation(list, id, pinned = true) {
    return (list || []).map((item) =>
      // Pinning is metadata, not activity: it must not reshuffle the list order.
      item.id === id ? { ...item, pinned: Boolean(pinned) } : item
    );
  }

  function renameConversation(list, id, title) {
    const value = String(title || "").trim().slice(0, 40);
    return (list || []).map((item) =>
      item.id === id && value ? { ...item, title: value } : item
    );
  }

  function removeConversation(list, id) {
    return (list || []).filter((item) => item.id !== id);
  }

  function activeConversationOf(state) {
    const list = state?.conversations || [];
    return list.find((item) => item.id === state?.activeId) || list[0] || null;
  }

  // localStorage budget: drop report snapshots from the oldest conversations
  // first, then whole conversations, instead of letting the write fail.
  function shrinkConversations(state, maxBytes = 3500000) {
    const working = {
      schema: CONVERSATION_SCHEMA,
      activeId: state?.activeId || null,
      conversations: (state?.conversations || []).map((item) => ({ ...item }))
    };
    const size = () => JSON.stringify(working).length;
    if (size() <= maxBytes) return working;
    const byOldest = (a, b) =>
      String(a.updatedAt || a.createdAt || "").localeCompare(
        String(b.updatedAt || b.createdAt || "")
      );
    const oldestFirst = [...working.conversations].sort(byOldest);
    for (const item of oldestFirst) {
      if (!item.report) continue;
      item.report = null;
      if (size() <= maxBytes) return working;
    }
    while (size() > maxBytes && working.conversations.length > 1) {
      const oldest = [...working.conversations].sort(byOldest)[0];
      working.conversations = working.conversations.filter(
        (item) => item.id !== oldest.id
      );
      if (working.activeId === oldest.id) {
        working.activeId = working.conversations[0]?.id || null;
      }
    }
    return working;
  }

  function serializeConversations(state) {
    const safe = shrinkConversations(state);
    return JSON.stringify({
      schema: CONVERSATION_SCHEMA,
      activeId: safe.activeId,
      conversations: safe.conversations
    });
  }

  function normalizeStoredConversation(value) {
    if (!value || typeof value !== "object") return null;
    const conversation = createConversation({
      id: value.id,
      at: value.createdAt,
      title: value.title
    });
    if (!conversation.id) return null;
    const messages = (Array.isArray(value.messages) ? value.messages : [])
      .map((message) => ({
        id: String(message?.id || ""),
        role: message?.role === "user" ? "user" : "assistant",
        text: String(message?.text || "").slice(0, 4000),
        blocks: Array.isArray(message?.blocks) ? message.blocks : [],
        at: String(message?.at || conversation.createdAt)
      }))
      .filter((message) => message.text);
    return {
      ...conversation,
      createdAt: String(value.createdAt || conversation.createdAt),
      updatedAt: String(value.updatedAt || value.createdAt || conversation.createdAt),
      pinned: Boolean(value.pinned),
      messages: trimConversationMessages(messages),
      report: value.report && typeof value.report === "object" ? value.report : null
    };
  }

  // Storage may contain older schemas or hand-edited JSON; anything unusable is
  // dropped instead of breaking the chat.
  function parseConversations(raw) {
    try {
      const parsed = JSON.parse(raw || "{}");
      const conversations = pruneConversations(
        (Array.isArray(parsed?.conversations) ? parsed.conversations : [])
          .map(normalizeStoredConversation)
          .filter(Boolean)
      );
      const activeId = conversations.some((item) => item.id === parsed?.activeId)
        ? parsed.activeId
        : conversations[0]?.id || null;
      return { conversations, activeId };
    } catch {
      return { conversations: [], activeId: null };
    }
  }

  function conversationLabel(state, now = new Date()) {
    const active = activeConversationOf(state);
    if (!active) return "新对话";
    const list = state?.conversations || [];
    // Titles repeat easily ("喜茶…" twice); number them in creation order.
    const sameTitle = list
      .filter((item) => item.title === active.title)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const position = sameTitle.findIndex((item) => item.id === active.id) + 1;
    return sameTitle.length > 1 ? `${active.title} (${position})` : active.title;
  }

  // One flat allowance for everyone: the tool no longer has accounts, so the
  // only thing left to show is how much of today's six runs is left.
  function quotaLabel(remaining, limit = 6) {
    if (remaining <= 0) return `今日免费额度已用完（每天 ${limit} 次）· 明天自动恢复`;
    return `今日免费额度 ${remaining}/${limit} 次`;
  }

  function canAnalyze(remaining) {
    return Number(remaining) > 0;
  }

  function escapeBlock(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  // Renders the structured answer blocks the assistant is allowed to emit:
  // text / callout / metric / task_list / table / sources / quote, plus the
  // confirm card the server appends after a form action. Anything else is
  // ignored, so the chat can never receive markup we did not design.
  function renderAnswerBlocks(blocks) {
    const html = (Array.isArray(blocks) ? blocks : [])
      .map((block) => {
        const type = block?.type;
        if (type === "text") {
          return `<p class="answer-text">${escapeBlock(block.text)}</p>`;
        }
        if (type === "callout") {
          const warn = block.tone === "warn";
          return `
            <div class="answer-callout ${warn ? "is-warn" : "is-info"}">
              <span class="answer-callout-mark" aria-hidden="true">${warn ? "!" : "i"}</span>
              <div class="answer-callout-body">
                ${block.title ? `<strong>${escapeBlock(block.title)}</strong>` : ""}
                <p>${escapeBlock(block.text)}</p>
              </div>
            </div>
          `;
        }
        if (type === "metric") {
          const items = (block.items || [])
            .map(
              (item) => `
                <div class="answer-metric">
                  <span class="answer-metric-label">${escapeBlock(item.label)}</span>
                  <strong class="answer-metric-value">${escapeBlock(item.value)}${
                    item.unit ? `<em>${escapeBlock(item.unit)}</em>` : ""
                  }</strong>
                  ${
                    item.hint
                      ? `<span class="answer-metric-hint">${escapeBlock(item.hint)}</span>`
                      : ""
                  }
                </div>
              `
            )
            .join("");
          return `
            <div class="answer-metric-block">
              ${block.title ? `<strong class="answer-metric-title">${escapeBlock(block.title)}</strong>` : ""}
              <div class="answer-metric-row">${items}</div>
            </div>
          `;
        }
        if (type === "task_list") {
          const items = (block.items || [])
            .map(
              (item) => {
                const source = item.questionNumber
                  ? `依据：第 ${escapeBlock(item.questionNumber)} 题${
                      item.model ? ` · ${escapeBlock(item.model)}` : ""
                    }`
                  : "";
                const meta = [item.owner, item.priority].filter(Boolean).join(" · ");
                return `
                  <li>
                    <span class="answer-task-check" aria-hidden="true"></span>
                    <span class="answer-task-body">
                      <span class="answer-task-text">${escapeBlock(item.text)}</span>
                      ${source ? `<span class="answer-task-source">${source}</span>` : ""}
                    </span>
                    ${
                      meta
                        ? `<span class="answer-task-meta">${escapeBlock(meta)}</span>`
                        : ""
                    }
                  </li>
                `;
              }
            )
            .join("");
          return `
            <div class="answer-task-list">
              ${block.title ? `<strong>${escapeBlock(block.title)}</strong>` : ""}
              <ul>${items}</ul>
            </div>
          `;
        }
        if (type === "table") {
          const head = (block.columns || [])
            .map((column) => `<th>${escapeBlock(column)}</th>`)
            .join("");
          const body = (block.rows || [])
            .map(
              (row) =>
                `<tr>${row.map((cell) => `<td>${escapeBlock(cell)}</td>`).join("")}</tr>`
            )
            .join("");
          return `
            <div class="answer-table-wrap">
              ${block.title ? `<strong>${escapeBlock(block.title)}</strong>` : ""}
              <table class="answer-table">
                <thead><tr>${head}</tr></thead>
                <tbody>${body}</tbody>
              </table>
            </div>
          `;
        }
        if (type === "sources") {
          const items = (block.items || [])
            .map(
              (item) => `
                <li>
                  <a href="${escapeBlock(item.url)}" target="_blank" rel="noopener noreferrer">
                    <span class="answer-source-title">${escapeBlock(item.title)}</span>
                    <span class="answer-source-host">${escapeBlock(item.host || "")}</span>
                    ${
                      item.snippet
                        ? `<span class="answer-source-snippet">${escapeBlock(item.snippet)}</span>`
                        : ""
                    }
                  </a>
                </li>
              `
            )
            .join("");
          return `
            <div class="answer-sources">
              ${block.title ? `<strong>${escapeBlock(block.title)}</strong>` : ""}
              <ul>${items}</ul>
            </div>
          `;
        }
        if (type === "quote") {
          const source = [
            block.questionNumber ? `第 ${block.questionNumber} 题` : "",
            block.model || ""
          ]
            .filter(Boolean)
            .join(" · ");
          return `
            <blockquote class="answer-quote">
              ${source ? `<strong>${escapeBlock(source)}</strong>` : ""}
              <span>${escapeBlock(block.text)}</span>
            </blockquote>
          `;
        }
        if (type === "confirm_card") {
          const fields = (block.fields || [])
            .map(
              (item) => `
                <div class="answer-confirm-field">
                  <span>${escapeBlock(item.label)}</span>
                  <strong>${escapeBlock(item.value)}</strong>
                </div>
              `
            )
            .join("");
          const sources = (block.sources || [])
            .map(
              (item) => `
                <a class="answer-confirm-source" href="${escapeBlock(
                  item.url
                )}" target="_blank" rel="noopener noreferrer" title="来源：${escapeBlock(
                  item.title
                )}"><i data-lucide="globe"></i><span>${escapeBlock(
                  item.title
                )}</span></a>
              `
            )
            .join("");
          return `
            <div class="answer-confirm" data-confirm-action="${escapeBlock(
              block.action?.type || "scroll_form"
            )}">
              ${block.title ? `<strong class="answer-confirm-title">${escapeBlock(block.title)}</strong>` : ""}
              <div class="answer-confirm-fields">${fields}</div>
              ${
                sources
                  ? `<div class="answer-confirm-sources"><span>型号来源</span>${sources}</div>`
                  : ""
              }
              <button type="button" class="answer-confirm-button">${escapeBlock(
                block.action?.label || "去确认"
              )}</button>
            </div>
          `;
        }
        return "";
      })
      .join("");
    // The chat bubble keeps pre-wrap for plain text, so drop the indentation
    // between tags or it would render as large vertical gaps.
    return html.replace(/>\s+</g, "><").trim();
  }

  // Turns plain-text URLs in an already-HTML-escaped string into links.
  // Only http(s) is accepted so "javascript:" style input can never become
  // an href.
  function linkify(value) {
    return String(value || "").replace(
      /(https?:\/\/[^\s<>"'）】]+)/g,
      (url) => {
        const trailing = url.match(/[.,;:!?，。、；：！？]+$/)?.[0] || "";
        const clean = trailing ? url.slice(0, -trailing.length) : url;
        return `<a href="${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${trailing}`;
      }
    );
  }

  function cleanAssistantText(value) {
    return String(value || "")
      .replace(/```(?:[a-z0-9_-]+)?\s*/gi, "")
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 $2")
      .replace(/\*\*([^*]+)\*\*/g, "$1")
      .replace(/__([^_]+)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^\s*[-*+]\s+/gm, "• ")
      .replace(/\r\n?/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return {
    activeConversationOf,
    appendConversationMessage,
    brandKeys,
    buildReport,
    canAnalyze,
    cleanAssistantText,
    cleanBrief,
    cleanList,
    competitorKeyList,
    CONVERSATION_LIMIT,
    CONVERSATION_MESSAGE_LIMIT,
    CONVERSATION_SCHEMA,
    conversationLabel,
    conversationTitleFrom,
    createConversation,
    formatScore,
    isOffTopic,
    linkify,
    makeQuestions,
    makeQuestionsForBrief,
    MIN_COMPETITOR_COVERAGE,
    MIN_ASKED_QUESTIONS,
    parseConversations,
    pinConversation,
    pruneConversations,
    RANKING_MIN_QUESTIONS,
    questionCoverage,
    questionBatchProblems,
    questionProblems,
    QUESTION_RECIPE,
    questionSceneKeys,
    removeConversation,
    renameConversation,
    SCENE_DIMENSIONS,
    quotaLabel,
    renderAnswerBlocks,
    serializeConversations,
    shrinkConversations,
    scoreFor,
    SCORE_DIMENSIONS,
    timelineFor
  };
});
