const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

let browser;

async function confirmQuestionReview(page, firstQuestion) {
  await page.waitForSelector('#questionEditorList textarea:not([disabled])');
  const count = await page.locator("#questionEditorList textarea").count();
  if (count !== 6) throw new Error("Question review does not contain six editable questions");
  await page.fill('[data-question-index="0"]', firstQuestion);
  await page.click("#confirmQuestions");
}

(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
  }
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1
  });

  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  const url = pathToFileURL(path.join(__dirname, "..", "index.html")).href;
  await page.goto(url);
  await page.waitForSelector("#workspace");
  const initialUi = await page.evaluate(() => ({
    mockPillCount: document.querySelectorAll(".mock-pill").length,
    formUploadCount: document.querySelectorAll(".upload-control").length,
    chatImageCount: document.querySelectorAll("#chatImageInput").length,
    checkFontSize: parseFloat(getComputedStyle(document.querySelector(".brand small")).fontSize),
    checkFontWeight: getComputedStyle(document.querySelector(".brand small")).fontWeight,
    brandValue: document.querySelector("#brandInput").value,
    competitorValues: [...document.querySelectorAll(".competitor-input")].map(
      (input) => input.value
    ),
    processHidden: document.querySelector("#process").hidden,
    reportHidden: document.querySelector("#report").hidden,
    quotaText: document.querySelector("#quotaText").textContent.trim(),
    dialogCount: document.querySelectorAll("dialog").length,
    // 这个产品只做一件事，注册与分享的入口必须彻底从 DOM 里消失。
    funnelNodes: [
      "#headerRegister",
      "#headerShare",
      "#footerShare",
      "#shareReport",
      "#monitorButton",
      "#shareDialog",
      "#registerDialog",
      "#inviteDialog",
      "#subscribeDialog",
      "#inviteHint",
      "#registerHint",
      "#shareContext"
    ].filter((selector) => document.querySelector(selector))
  }));
  if (initialUi.mockPillCount !== 0) {
    throw new Error("Header branding must not carry a mock pill");
  }
  if (initialUi.funnelNodes.length || initialUi.dialogCount !== 0) {
    throw new Error(
      `Registration and sharing UI is still rendered: ${initialUi.funnelNodes.join(", ")}`
    );
  }
  if (initialUi.quotaText !== "今日免费额度 6/6 次") {
    throw new Error(`Daily free quota is not six runs: ${initialUi.quotaText}`);
  }
  if (initialUi.formUploadCount !== 0 || initialUi.chatImageCount !== 1) {
    throw new Error("Image input is not scoped to the AI assistant");
  }
  if (initialUi.checkFontSize < 14 || Number(initialUi.checkFontWeight) < 700) {
    throw new Error("Check wordmark is not emphasized");
  }
  if (
    initialUi.brandValue ||
    initialUi.competitorValues.some(Boolean) ||
    !initialUi.processHidden ||
    !initialUi.reportHidden
  ) {
    throw new Error("Fresh load still contains preset report state or form values");
  }

  // 先往示例不会用到的位置填字，确认“试试示例”会把它们清空。
  await page.fill(".competitor-input >> nth=1", "用户自己填的竞品");
  await page.fill(".competitor-product-input >> nth=1", "用户自己填的型号");
  await page.fill(".competitor-input >> nth=2", "另一个竞品");
  await page.click("#fillExample");
  const exampleState = await page.evaluate(() => ({
    brand: document.querySelector("#brandInput").value,
    brandProduct: document.querySelector("#brandProductInput").value,
    competitor: document.querySelector(".competitor-input").value,
    competitorProduct: document.querySelector(".competitor-product-input").value,
    competitorValues: [...document.querySelectorAll(".competitor-input")].map(
      (input) => input.value
    ),
    competitorProductValues: [...document.querySelectorAll(".competitor-product-input")].map(
      (input) => input.value
    ),
    selectedDirections: [...document.querySelectorAll(".direction-checkbox:checked")].map(
      (input) => input.value
    ),
    processHidden: document.querySelector("#process").hidden,
    reportHidden: document.querySelector("#report").hidden
  }));
  if (
    exampleState.brand !== "小米" ||
    exampleState.brandProduct !== "小米 14" ||
    exampleState.competitor !== "Apple" ||
    exampleState.competitorProduct !== "iPhone 17 Pro" ||
    // 示例用不到的位置必须被清空，不能留着用户自己填的内容。
    exampleState.competitorValues.slice(1).some(Boolean) ||
    exampleState.competitorProductValues.slice(1).some(Boolean) ||
    exampleState.selectedDirections[0] !== "产品体验" ||
    !exampleState.processHidden ||
    !exampleState.reportHidden
  ) {
    throw new Error("Example action must only fill the form");
  }
  await page.click("#startAnalysis");
  await page.waitForFunction(
    () => document.querySelectorAll("#questionEditorList textarea").length === 6,
    null,
    { timeout: 4000 }
  );
  const questionReviewLayout = await page.evaluate(() => {
    const review = document.querySelector(".question-review").getBoundingClientRect();
    return {
      width: review.width,
      textareaCount: document.querySelectorAll("#questionEditorList textarea").length,
      processHidden: document.querySelector("#process").hidden,
      questionText: document.querySelector("#questionEditorList").textContent,
      coverageHidden: document.querySelector("#questionCoverage").hidden,
      coverageChips: document.querySelectorAll("#questionCoverage .coverage-chip").length,
      coverageText: document.querySelector("#questionCoverage").textContent
    };
  });
  if (
    questionReviewLayout.width < 420 ||
    questionReviewLayout.textareaCount !== 6 ||
    !questionReviewLayout.questionText.includes("小米 14") ||
    !questionReviewLayout.questionText.includes("产品体验") ||
    questionReviewLayout.processHidden
  ) {
    throw new Error("Editable question review is not ready before testing");
  }
  if (
    questionReviewLayout.coverageHidden ||
    questionReviewLayout.coverageChips < 2 ||
    !/覆盖情况/.test(questionReviewLayout.coverageText)
  ) {
    throw new Error(
      `Question editor does not show per-entity coverage: ${JSON.stringify(
        questionReviewLayout
      )}`
    );
  }
  await page.screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "desktop.png"),
    fullPage: true
  });
  await confirmQuestionReview(
    page,
    "自定义问题：小米 14 和 iPhone 17 Pro 的核心差异是什么？"
  );
  await page.waitForFunction(
    () => document.querySelector("#timeline").textContent.includes("1/6"),
    null,
    { timeout: 2000 }
  );
  await page.waitForFunction(() => {
    const status = document.querySelector("#processStatus")?.textContent || "";
    const label = document.querySelector("#startAnalysis span")?.textContent || "";
    return status.includes("分析完成") && !label.includes("正在检测");
  }, null, { timeout: 8000 });
  if (!(await page.locator("#questionTable").innerText()).includes("自定义问题")) {
    throw new Error("Edited questions were not submitted to the report");
  }
  if ((await page.locator(".answer-card").count()) !== 12) {
    throw new Error("Question details do not expose all twelve model answers");
  }
  if ((await page.locator(".answer-content strong").count()) < 1) {
    throw new Error("Markdown model answers are not rendered");
  }
  await page.click('[data-tab="questions"]');
  const questionLayout = await page.evaluate(() => {
    const header = document.querySelector(".question-head-index");
    const grid = getComputedStyle(document.querySelector(".answer-grid"));
    return {
      headerText: header.textContent.trim(),
      columns: grid.gridTemplateColumns,
      gap: grid.gap
    };
  });
  if (
    questionLayout.headerText !== "" ||
    questionLayout.columns.split(" ").length !== 1 ||
    parseFloat(questionLayout.gap) < 20
  ) {
    throw new Error("Question detail typography and answer layout are incorrect");
  }
  await page.click(".question-score-button");
  const scoreToggleLabel = await page.locator(".question-score-toggle").first().innerText();
  const scoreBreakdown = await page.locator(".score-breakdown:not([hidden])").innerText();
  const scoreColumns = await page.locator(".score-table thead th").count();
  if (
    !scoreToggleLabel.includes("得分明细") ||
    !scoreBreakdown.includes("推荐出现") ||
    !scoreBreakdown.includes("本题合计") ||
    scoreColumns < 2
  ) {
    throw new Error("Question score breakdown is not available");
  }
  await page.screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "score-breakdown.png"),
    fullPage: true
  });
  const scoreColumnAlignment = await page.evaluate(() => {
    const openTable = document.querySelector(".score-breakdown:not([hidden]) .score-table");
    const head = openTable.querySelector("thead th:first-child").getBoundingClientRect();
    const row = openTable.querySelector("tbody th:first-child").getBoundingClientRect();
    return { head: Math.round(head.left), row: Math.round(row.left) };
  });
  if (Math.abs(scoreColumnAlignment.head - scoreColumnAlignment.row) > 1) {
    throw new Error("Score table dimension column is not aligned with its rows");
  }
  const entityHeadAlignment = await page.evaluate(() => {
    const openTable = document.querySelector(".score-breakdown:not([hidden]) .score-table");
    return [...openTable.querySelectorAll("thead th")]
      .filter((cell) => cell.querySelector("strong"))
      .map((cell) => {
        const name = cell.querySelector("strong").getBoundingClientRect();
        const role = cell.querySelector("span").getBoundingClientRect();
        return {
          role: cell.querySelector("span").textContent.trim(),
          delta: Math.abs(Math.round(name.right) - Math.round(role.right))
        };
      });
  });
  if (
    entityHeadAlignment.length < 2 ||
    entityHeadAlignment.some((item) => item.delta > 1) ||
    entityHeadAlignment.some((item) => /[（）()]/.test(item.role))
  ) {
    throw new Error(
      `Entity header name and role are not aligned: ${JSON.stringify(entityHeadAlignment)}`
    );
  }
  const answerAlignment = await page.evaluate(() => {
    const question = document
      .querySelector(".question-summary-row > strong")
      .getBoundingClientRect();
    const answer = document.querySelector(".answer-card").getBoundingClientRect();
    return { question: Math.round(question.left), answer: Math.round(answer.left) };
  });
  if (Math.abs(answerAlignment.question - answerAlignment.answer) > 1) {
    throw new Error("Answer cards are not aligned with the buyer question text");
  }
  // The fourth question does not ask about the competitor in the mock report,
  // so its cells must read "-" instead of a fake zero.
  await page.click('[data-score-index="3"]');
  const scoreMarks = await page.evaluate(() => {
    const open = document.querySelector('[data-score-breakdown="3"]');
    return {
      notApplicable: open.querySelectorAll("td.score-na").length,
      coverage: open.querySelector(".score-coverage")?.textContent.trim() || ""
    };
  });
  if (scoreMarks.notApplicable < 1 || !/覆盖/.test(scoreMarks.coverage)) {
    throw new Error(
      `Score detail does not mark unasked questions: ${JSON.stringify(scoreMarks)}`
    );
  }
  const reportStructure = await page.evaluate(() => ({
    scoring: document.querySelector("#scoringStandardBody").textContent,
    analysisCount: document.querySelectorAll(".recommendation-analysis").length,
    suggestionCount: document.querySelectorAll(".recommendation-suggestion").length,
    impactCount: document.querySelectorAll(".recommendations .impact").length
  }));
  if (
    !reportStructure.scoring.includes("推荐出现 × 25%") ||
    reportStructure.analysisCount < 1 ||
    reportStructure.suggestionCount < 1 ||
    reportStructure.impactCount !== 0
  ) {
    throw new Error("Report scoring or recommendation layout is incomplete");
  }
  const positioningText = await page.locator("#positioningSummary").innerText();
  const positioningItems = await page.locator(".positioning-item").count();
  const conflictItems = await page.locator(".positioning-conflict").count();
  if (
    positioningItems < 1 ||
    !positioningText.includes("模型共识") ||
    !positioningText.includes("与竞品的关键差异") ||
    !positioningText.includes("模型描述冲突") ||
    conflictItems < 1
  ) {
    throw new Error("Positioning diagnostic card is not rendered");
  }
  await page.click('[data-tab="overview"]');
  const rankingUi = await page.evaluate(() => ({
    ranks: [...document.querySelectorAll("#competitorChart .bar-rank")].map((node) =>
      node.textContent.trim()
    ),
    metricLabels: [...document.querySelectorAll(".metric-row span")].map((node) =>
      node.textContent.trim()
    ),
    metricValues: [
      document.querySelector("#mentionMetric")?.textContent.trim() || "",
      document.querySelector("#firstChoiceMetric")?.textContent.trim() || ""
    ],
    sampleRule: document.querySelector("#scoringSampleRule").textContent.trim()
  }));
  if (
    !rankingUi.ranks.some((rank) => /^#\d+$/.test(rank)) ||
    rankingUi.metricLabels[0] !== "主动推荐率" ||
    rankingUi.metricLabels[1] !== "首选率" ||
    rankingUi.metricLabels.length !== 2 ||
    rankingUi.metricValues.some((value) => !/^\d+%$/.test(value)) ||
    !/每个竞品至少出现在/.test(rankingUi.sampleRule) ||
    !/不参与排名/.test(rankingUi.sampleRule) ||
    !/样本不足/.test(rankingUi.sampleRule) ||
    /(\d+)–\1/.test(rankingUi.sampleRule)
  ) {
    throw new Error(`Ranking or sample rule is missing: ${JSON.stringify(rankingUi)}`);
  }
  await page.locator("#competitorChart").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "competitor-ranking.png")
  });
  // Park the metrics in the middle of the viewport: the sticky nav otherwise
  // covers them in the screenshot.
  await page.evaluate(() =>
    document.querySelector(".metric-row").scrollIntoView({ block: "center" })
  );
  await page.locator(".metric-row").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "report-metrics.png")
  });
  await page.locator(".positioning-block").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "positioning.png")
  });
  await page.locator(".recommendations").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "recommendations.png")
  });
  await page.click(".notes-section summary");
  const notesText = await page.locator(".notes-section").innerText();
  if (
    !notesText.includes("怎么用") ||
    !notesText.includes("每天 6 次免费检测") ||
    !notesText.includes("评分标准与计算方式") ||
    /Mock|注册|邀请码|分享报告|每周监控/.test(notesText)
  ) {
    throw new Error(`Notes module is not a plain product manual: ${notesText.slice(0, 240)}`);
  }
  await page.locator(".notes-section").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "notes.png")
  });

  // The local mock flow has no judge verdicts, so render a report that carries
  // them and check the "判定依据" block that hangs off every answer.
  const rationale = await page.evaluate(() => {
    const report = window.VisibilityCore.buildReport("喜茶", ["林里", "奈雪"]);
    report.judge = { judgedAnswers: 2, ruleAnswers: 10, totalAnswers: 12 };
    report.positioning = {
      ...(report.positioning || {}),
      coverageGaps: [
        {
          entityId: "brand",
          entityName: "喜茶",
          entityType: "brand",
          questionIndex: 2,
          question: "喜茶和林里哪个更适合夏天？",
          sides: [
            {
              provider: "deepseek",
              model: "deepseek-flash",
              mentioned: false,
              quote: ""
            },
            {
              provider: "glm",
              model: "glm-4.6v",
              mentioned: true,
              quote: "喜茶的果酸平衡更适合夏天。"
            }
          ]
        }
      ]
    };
    report.suggestions = (report.suggestions || []).map((item, index) =>
      index === 1
        ? {
            ...item,
            // Two short measures on their own lines: only pre-wrap keeps them
            // from collapsing into one line.
            suggestion: "· 做一条 30 秒对比视频。\n· 新增一栏实测数据。\n· 一周后用同一组问题复测。"
          }
        : index === 0
        ? {
            ...item,
            source: {
              id: "background_1",
              kind: "category",
              label: "品类推荐现状",
              title: "2026 果茶推荐榜单",
              url: "https://example.com/ranking",
              host: "example.com"
            }
          }
        : item
    );
    report.questions = report.questions || [];
    report.observations = [
      {
        model: "deepseek-flash",
        provider: "deepseek",
        questionIndex: 0,
        question: "喜茶和林里在清爽果茶上哪个更合适？",
        answer: "只看清爽度我会先推喜茶：果酸更平衡，单杯 16 元。林里的甜度偏高，适合重口味的场景。",
        judged: true,
        judgments: {
          brand: {
            dimensions: { presence: 100, rank: 100, sentiment: 100, evidence: 50, differentiation: 67 },
            applicable: { presence: true, rank: true, sentiment: true, evidence: true, differentiation: true },
            reasons: {
              presence: "回答直接推荐了喜茶并说明理由。",
              rank: "回答说“先推喜茶”，是第一名。",
              sentiment: "整体是正面推荐。",
              evidence: "两条主张里一条带具体价格。",
              differentiation: "与林里做了甜度对比，但没有给出选择条件。"
            },
            claims: [
              { text: "喜茶果酸更平衡", kind: "vague" },
              { text: "喜茶单杯 16 元", kind: "specific" }
            ],
            quote: "只看清爽度我会先推喜茶",
            rank: 1,
            tone: "positive",
            score: 85
          },
          competitor_1: {
            dimensions: { presence: 50, rank: 0, sentiment: 20, evidence: 0, differentiation: 67 },
            applicable: { presence: true, rank: false, sentiment: true, evidence: false, differentiation: true },
            reasons: {
              presence: "回答提到了林里并评价了甜度。",
              rank: "回答没有给出林里的名次。",
              sentiment: "描述偏负面（甜度偏高）。",
              evidence: "只有形容词，没有具体依据。",
              differentiation: "与喜茶做了甜度对比。"
            },
            claims: [{ text: "林里甜度偏高", kind: "vague" }],
            quote: "林里的甜度偏高",
            rank: null,
            tone: "negative",
            score: 36
          }
        }
      },
      {
        model: "glm-4.6v",
        provider: "glm",
        questionIndex: 0,
        question: "喜茶和林里在清爽果茶上哪个更合适？",
        answer: "两家都不错，喜茶更常见一些。",
        judged: false,
        judgments: {}
      }
    ];
    window.answerLensQA.renderReport(report);
    const card = document.querySelector(".answer-card");
    const details = card?.querySelector(".answer-rationale");
    if (details) details.open = true;
    const gap = document.querySelector(".positioning-gap");
    return {
      cards: document.querySelectorAll(".answer-card").length,
      details: document.querySelectorAll(".answer-rationale").length,
      entities: document.querySelectorAll(".rationale-entity").length,
      rows: document.querySelectorAll(".rationale-entity li").length,
      naRows: document.querySelectorAll(".rationale-value.is-na").length,
      quote: card?.querySelector(".rationale-quote")?.textContent || "",
      firstRow: card?.querySelector(".rationale-entity li")?.textContent || "",
      degraded: document.querySelectorAll(".answer-rationale summary span").length,
      coverageGaps: document.querySelectorAll(".positioning-gap").length,
      gapSummary: gap?.querySelector(".positioning-gap-summary")?.textContent.trim() || "",
      gapMissing: gap?.querySelector("blockquote.is-missing")?.textContent.trim() || ""
    };
  });
  // The answer cards live behind the 提问明细 tab.
  await page.click('[data-tab="questions"]');
  if (
    rationale.cards < 2 ||
    rationale.details !== 2 ||
    rationale.entities !== 2 ||
    rationale.rows !== 10 ||
    rationale.naRows !== 2 ||
    rationale.coverageGaps !== 1 ||
    !/第 3 题 · 喜茶/.test(rationale.gapSummary) ||
    !/没有提到该产品/.test(rationale.gapMissing) ||
    !/先推喜茶/.test(rationale.quote) ||
    !/推荐出现/.test(rationale.firstRow)
  ) {
    throw new Error(`Answer rationale is not rendered: ${JSON.stringify(rationale)}`);
  }
  await page.locator(".answer-card").first().screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "score-rationale.png")
  });
  // The external source of a recommendation must be a globe, never a pasted URL.
  await page.click('[data-tab="overview"]');
  await page.locator(".positioning-block").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "positioning-gap.png")
  });
  const recommendationSource = await page.evaluate(() => {
    const link = document.querySelector(".recommendation-suggestion .recommendation-source");
    if (!link) return null;
    return {
      href: link.getAttribute("href"),
      target: link.getAttribute("target"),
      rel: link.getAttribute("rel"),
      title: link.getAttribute("title") || "",
      text: link.textContent.trim(),
      icon: Boolean(link.querySelector("svg") || link.querySelector("[data-lucide]"))
    };
  });
  if (
    !recommendationSource ||
    recommendationSource.href !== "https://example.com/ranking" ||
    recommendationSource.target !== "_blank" ||
    !/noopener/.test(recommendationSource.rel) ||
    !/2026 果茶推荐榜单/.test(recommendationSource.title) ||
    recommendationSource.text !== "" ||
    !recommendationSource.icon
  ) {
    throw new Error(
      `Recommendation source is not an icon link: ${JSON.stringify(recommendationSource)}`
    );
  }
  await page.locator(".recommendations").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "recommendations-source.png")
  });
  const measureLines = await page.evaluate(() => {
    const paragraphs = [...document.querySelectorAll(".recommendation-suggestion > p")];
    const target = paragraphs[1];
    const style = getComputedStyle(target);
    const title = target.closest(".recommendation-suggestion")?.querySelector("strong");
    const firstLine = target.textContent.split("\n")[0].trim();
    return {
      whiteSpace: style.whiteSpace,
      lineHeight: parseFloat(style.lineHeight),
      fontSize: parseFloat(style.fontSize),
      letterSpacing: style.letterSpacing,
      height: target.getBoundingClientRect().height,
      titleSize: title ? parseFloat(getComputedStyle(title).fontSize) : 0,
      analysisSize: parseFloat(
        getComputedStyle(document.querySelector(".recommendation-analysis > p")).fontSize
      ),
      firstLine
    };
  });
  if (
    measureLines.whiteSpace !== "pre-wrap" ||
    measureLines.height < measureLines.lineHeight * 2.5 ||
    // 建议正文要比分析正文明显更大、更松。
    measureLines.fontSize < 18 ||
    measureLines.letterSpacing === "normal" ||
    // 层级：建议标题 > 建议正文 > 分析正文
    measureLines.titleSize <= measureLines.fontSize ||
    measureLines.fontSize <= measureLines.analysisSize ||
    // 第一个要点也要有“· ”，不能只有后面几条带。
    !measureLines.firstLine.startsWith("·")
  ) {
    throw new Error(
      `Suggestion measures do not keep their line breaks: ${JSON.stringify(measureLines)}`
    );
  }
  // 评分标准与计算方式搬到了页面底部的「说明」里，报告总览不能再有它。
  const scoringHome = await page.evaluate(() => ({
    inNotes: Boolean(document.querySelector("#notes #scoringStandard")),
    inReport: Boolean(document.querySelector("#report #scoringStandard"))
  }));
  if (!scoringHome.inNotes || scoringHome.inReport) {
    throw new Error(
      `Scoring standard is not parked in the note: ${JSON.stringify(scoringHome)}`
    );
  }
  await page.evaluate(() => {
    document.querySelector("#scoringStandard").open = true;
  });
  const scoringText = await page.locator("#scoringStandardBody").innerText();
  if (
    !/不参与加权/.test(scoringText) ||
    !/判定依据/.test(scoringText) ||
    !/第 1 名 = 100/.test(scoringText) ||
    !/公式：/.test(scoringText) ||
    !/档位：/.test(scoringText) ||
    !/备用口径 · 规则判定/.test(scoringText) ||
    !/首次出现的位置排序/.test(scoringText) ||
    /rubric/i.test(scoringText)
  ) {
    throw new Error(`Scoring standard does not explain the judging rules: ${scoringText}`);
  }
  const scoringSections = await page.evaluate(() => {
    const blocks = [...document.querySelectorAll("#scoringStandard .scoring-block")];
    const tiers = [...document.querySelectorAll("#scoringStandard .scoring-tier-line")];
    const kickers = [...document.querySelectorAll("#scoringStandard .scoring-block-kicker")];
    const bodySizes = [...document.querySelectorAll("#scoringStandard .scoring-note")];
    return {
      count: blocks.length,
      kickers: kickers.map((node) => node.textContent.trim()),
      kickerSizes: [...new Set(kickers.map((node) => parseFloat(getComputedStyle(node).fontSize)))],
      kickerColours: [...new Set(kickers.map((node) => getComputedStyle(node).color))],
      bodySize: bodySizes.length ? parseFloat(getComputedStyle(bodySizes[0]).fontSize) : 0,
      formulas: document.querySelectorAll("#scoringStandard .scoring-formula-line").length,
      tiers: tiers.length,
      smallestTierCount: tiers.length
        ? Math.min(...tiers.map((line) => line.querySelectorAll("b").length))
        : 0,
      separated: blocks.slice(1).every((block) => {
        const style = getComputedStyle(block);
        return parseFloat(style.borderTopWidth) >= 1;
      })
    };
  });
  if (
    scoringSections.count < 6 ||
    !scoringSections.separated ||
    scoringSections.formulas !== 5 ||
    scoringSections.tiers !== 5 ||
    scoringSections.smallestTierCount < 4 ||
    // 小标题与正文同号，且用主题橙。
    scoringSections.kickerSizes.length !== 1 ||
    scoringSections.kickerSizes[0] !== scoringSections.bodySize ||
    scoringSections.kickerColours.length !== 1 ||
    // 与报告里其他橙色小标题（.block-kicker）同色。
    scoringSections.kickerColours[0] !== "rgb(200, 70, 11)" ||
    !scoringSections.kickers.includes("备用口径 · 规则判定") ||
    !scoringSections.kickers.includes("样本与覆盖")
  ) {
    throw new Error(`Scoring standard sections are not separated: ${JSON.stringify(scoringSections)}`);
  }
  // 评分标准与计算方式要有可展开的箭头提示：收起朝下，展开翻转。
  const scoringArrow = await page.evaluate(async () => {
    const details = document.querySelector("#scoringStandard");
    const svg = details.querySelector("summary svg");
    details.open = false;
    await new Promise((resolve) => setTimeout(resolve, 320));
    const closedTransform = getComputedStyle(svg).transform;
    details.open = true;
    await new Promise((resolve) => setTimeout(resolve, 320));
    const openTransform = getComputedStyle(svg).transform;
    const rect = svg.getBoundingClientRect();
    // 「说明」自己的箭头也必须仍然会翻转。
    const outerTransform = getComputedStyle(
      document.querySelector("#notes > details > summary svg")
    ).transform;
    // 箭头要贴着标题，而不是被推到整行最右边。
    const labelRect = details.querySelector("summary span").getBoundingClientRect();
    const summaryRect = details.querySelector("summary").getBoundingClientRect();
    // 「说明」自己的箭头也要贴着标题。
    const notesSummary = document.querySelector("#notes > details > summary");
    const notesLabel = notesSummary.querySelector("span").getBoundingClientRect();
    const notesSvg = notesSummary.querySelector("svg").getBoundingClientRect();
    return {
      label: details.querySelector("summary").textContent.trim(),
      width: rect.width,
      height: rect.height,
      closedTransform,
      openTransform,
      outerTransform,
      labelGap: rect.left - labelRect.right,
      distanceFromRight: summaryRect.right - rect.right,
      notesLabelGap: notesSvg.left - notesLabel.right,
      notesDistanceFromRight: notesSummary.getBoundingClientRect().right - notesSvg.right
    };
  });
  if (
    scoringArrow.label !== "评分标准与计算方式" ||
    scoringArrow.width < 10 ||
    scoringArrow.height < 10 ||
    scoringArrow.openTransform === scoringArrow.closedTransform ||
    !/matrix\(-1/.test(scoringArrow.openTransform) ||
    !/matrix\(-1/.test(scoringArrow.outerTransform) ||
    scoringArrow.labelGap < 2 ||
    scoringArrow.labelGap > 24 ||
    scoringArrow.distanceFromRight < 100 ||
    scoringArrow.notesLabelGap < 2 ||
    scoringArrow.notesLabelGap > 24 ||
    scoringArrow.notesDistanceFromRight < 100
  ) {
    throw new Error(
      `Scoring standard has no expandable arrow: ${JSON.stringify(scoringArrow)}`
    );
  }
  await page.locator("#scoringStandard").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "scoring-standard.png")
  });

  await page.click("#chatToggle");
  await page.waitForSelector("#chatPanel:not([hidden])");
  const desktopChat = await page.evaluate(() => {
    const panel = document.querySelector("#chatPanel").getBoundingClientRect();
    return { width: panel.width, height: panel.height };
  });
  if (desktopChat.width < 650 || desktopChat.height < 700) {
    throw new Error("Desktop AnswerLens Copilot panel is too small");
  }
  await page.fill("#chatInput", "测试对话");
  await page.click("#chatForm button[type=submit]");
  await page.waitForFunction(() => {
    const messages = document.querySelectorAll(".chat-message");
    return messages.length >= 2;
  });
  const chatMessageStyle = await page.evaluate(() => {
    const style = getComputedStyle(document.querySelector(".chat-message p"));
    return {
      fontSize: parseFloat(style.fontSize),
      whiteSpace: style.whiteSpace
    };
  });
  if (chatMessageStyle.fontSize < 14 || chatMessageStyle.whiteSpace !== "pre-wrap") {
    throw new Error("AnswerLens Copilot message typography is not readable");
  }
  const sourceLink = await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.innerHTML = window.VisibilityCore.linkify(
      "来源：喜茶新品 https://example.com/news。"
    );
    const anchor = probe.querySelector("a");
    return anchor
      ? {
          href: anchor.getAttribute("href"),
          target: anchor.getAttribute("target"),
          rel: anchor.getAttribute("rel"),
          tail: probe.textContent.trim().slice(-1)
        }
      : null;
  });
  if (
    !sourceLink ||
    sourceLink.href !== "https://example.com/news" ||
    sourceLink.target !== "_blank" ||
    !/noopener/.test(sourceLink.rel) ||
    sourceLink.tail !== "。"
  ) {
    throw new Error(`Source links are not clickable: ${JSON.stringify(sourceLink)}`);
  }
  // Render a structured answer with the real renderer and check the components
  // actually appear in the chat.
  const answerComponents = await page.evaluate(() => {
    const host = document.createElement("div");
    host.className = "chat-message";
    host.innerHTML = `<div class="chat-content">${window.VisibilityCore.renderAnswerBlocks([
      { type: "text", text: "报告里已经有 3 条行动建议，我按报告原文整理成待认领任务。" },
      {
        type: "callout",
        tone: "warn",
        title: "样本不足",
        text: "阿迪达斯只被问到 2 题，样本偏少 · 不参与排名。"
      },
      {
        type: "metric",
        title: "AI 推荐表现",
        items: [
          { label: "总分", value: "58", unit: "分", hint: "6 题平均" },
          { label: "排名", value: "#2", hint: "共 4 个对象" },
          { label: "推荐出现率", value: "83", unit: "%", hint: "12 条回答" },
          { label: "证据覆盖", value: "100", unit: "%" }
        ]
      },
      {
        type: "task_list",
        title: "可认领任务",
        items: [
          {
            text: "补充城市通勤场景的续航达成率实测",
            owner: "产品",
            priority: "高",
            questionNumber: 2,
            model: "GLM 4.6v"
          },
          {
            text: "补齐高速快充功率与充电曲线说明",
            owner: "市场",
            priority: "中",
            questionNumber: 4
          }
        ]
      },
      {
        type: "table",
        title: "逐题对比",
        columns: ["题号", "比亚迪", "蔚来"],
        rows: [["第 2 题", "88", "91"], ["第 3 题", "76", "84"]]
      },
      {
        type: "sources",
        title: "外部来源",
        items: [
          {
            title: "某媒体实测报道",
            url: "https://example.com/report",
            host: "example.com",
            snippet: "冬季续航实测数据对比。"
          }
        ]
      },
      { type: "quote", questionNumber: 2, model: "DeepSeek Flash", text: "表显估算不如蔚来、小鹏贴近真实" },
      {
        type: "confirm_card",
        title: "已填好检测表单",
        fields: [
          { label: "品牌", value: "比亚迪" },
          { label: "竞品", value: "蔚来、小鹏" },
          { label: "其他补充", value: "重点比较冬季续航" }
        ],
        sources: [
          {
            title: "比亚迪官网发布页",
            url: "https://example.com/byd",
            host: "example.com"
          }
        ],
        action: { type: "scroll_form", label: "去确认并开始检测" }
      }
    ])}</div>`;
    document.querySelector("#chatMessages").appendChild(host);
    const metricRow = host.querySelector(".answer-metric-row");
    return {
      tasks: host.querySelectorAll(".answer-task-list li").length,
      checkboxes: host.querySelectorAll(".answer-task-check").length,
      taskSources: host.querySelectorAll(".answer-task-source").length,
      taskSourceText: host.querySelector(".answer-task-source")?.textContent || "",
      tableRows: host.querySelectorAll(".answer-table tbody tr").length,
      sources: host.querySelectorAll(".answer-sources a").length,
      quotes: host.querySelectorAll(".answer-quote").length,
      quoteSource: host.querySelector(".answer-quote strong")?.textContent || "",
      callouts: host.querySelectorAll(".answer-callout.is-warn").length,
      calloutMark: host.querySelector(".answer-callout-mark")?.textContent || "",
      metrics: host.querySelectorAll(".answer-metric").length,
      metricColumns: metricRow
        ? getComputedStyle(metricRow).gridTemplateColumns.split(" ").length
        : 0,
      metricValueFontSize: parseFloat(
        getComputedStyle(host.querySelector(".answer-metric-value")).fontSize
      ),
      confirmCards: host.querySelectorAll(".answer-confirm").length,
      confirmFields: host.querySelectorAll(".answer-confirm-field").length,
      confirmSources: host.querySelectorAll(".answer-confirm-source").length,
      confirmSourceHref: host.querySelector(".answer-confirm-source")?.getAttribute("href") || "",
      confirmSourceText: host.querySelector(".answer-confirm-source")?.textContent.trim() || "",
      confirmLabel: host.querySelector(".answer-confirm-button")?.textContent || "",
      escaped: host.querySelector(".answer-text").textContent
    };
  });
  if (
    answerComponents.tasks !== 2 ||
    answerComponents.checkboxes !== 2 ||
    answerComponents.tableRows !== 2 ||
    answerComponents.sources !== 1 ||
    answerComponents.quotes !== 1
  ) {
    throw new Error(
      `Structured answer components did not render: ${JSON.stringify(answerComponents)}`
    );
  }
  if (
    answerComponents.taskSources !== 2 ||
    !/第 2 题 · GLM 4\.6v/.test(answerComponents.taskSourceText) ||
    !/第 2 题 · DeepSeek Flash/.test(answerComponents.quoteSource) ||
    answerComponents.callouts !== 1 ||
    answerComponents.calloutMark !== "!" ||
    answerComponents.metrics !== 4 ||
    answerComponents.metricColumns < 4 ||
    answerComponents.metricValueFontSize < 22 ||
    answerComponents.confirmCards !== 1 ||
    answerComponents.confirmFields !== 3 ||
    answerComponents.confirmSources !== 1 ||
    answerComponents.confirmSourceHref !== "https://example.com/byd" ||
    !/比亚迪官网发布页/.test(answerComponents.confirmSourceText) ||
    /example\.com\/byd/.test(answerComponents.confirmSourceText) ||
    answerComponents.confirmLabel !== "去确认并开始检测"
  ) {
    throw new Error(
      `New answer components did not render: ${JSON.stringify(answerComponents)}`
    );
  }
  await page.locator("#chatPanel").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "chat-components.png")
  });
  // The confirm card and the source line of a quote sit below the fold.
  await page.evaluate(() => {
    const messages = document.querySelector("#chatMessages");
    messages.scrollTop = messages.scrollHeight;
  });
  await page.locator("#chatPanel").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "chat-confirm-card.png")
  });

  await page.click("#closeChat");

  // Conversations belong to the user: new chat, switch, rename, delete — and
  // none of it is touched by the analysis flow.
  await page.click("#chatToggle");
  await page.waitForSelector("#chatPanel:not([hidden])");
  await page.click("#toggleConversations");
  const conversationUi = await page.evaluate(() => ({
    drawerVisible: !document.querySelector("#chatConversations").hidden,
    drawerWidth: Math.round(
      document.querySelector("#chatConversations").getBoundingClientRect().width
    ),
    drawerHeight: Math.round(
      document.querySelector("#chatConversations").getBoundingClientRect().height
    ),
    listHeight: Math.round(
      document.querySelector("#conversationList").getBoundingClientRect().height
    ),
    count: document.querySelectorAll(".conversation-item").length,
    title: document.querySelector(".conversation-open .conversation-title")?.textContent.trim() || "",
    meta: document.querySelector(".conversation-open .conversation-meta")?.textContent.trim() || "",
    // 原生 tooltip 必须去掉：悬停信息只在界面里显示。
    metaTooltip: document.querySelector(".conversation-open")?.getAttribute("title") || "",
    metaOpacity: getComputedStyle(
      document.querySelector(".conversation-open .conversation-meta")
    ).opacity,
    moreOpacity: getComputedStyle(document.querySelector(".conversation-more")).opacity,
    label: document.querySelector("#chatConversationLabel")?.textContent.trim() || "",
    messages: document.querySelectorAll("#chatMessages .chat-message").length,
    headerButtonIds: [...document.querySelectorAll(".chat-header-actions .icon-button")].map(
      (button) => button.id
    ),
    headerIcons: [...document.querySelectorAll(".chat-header-actions button")].map((button) => {
      const icon = button.querySelector("svg, [data-lucide]");
      if (!icon) return "";
      return icon.getAttribute("data-lucide") || icon.getAttribute("class") || "";
    }),
    noteGone: !document.querySelector(".conversation-note"),
    textButtonGone: !document.querySelector(".conversation-new")
  }));
  if (
    !conversationUi.drawerVisible ||
    // 侧边栏必须真的露出列表，不能只留一条缝。
    conversationUi.drawerWidth < 200 ||
    conversationUi.listHeight < 30 ||
    conversationUi.drawerHeight < conversationUi.listHeight ||
    conversationUi.count !== 1 ||
    conversationUi.metaTooltip !== "" ||
    // 未悬停时消息数量和时间是隐藏的，鼠标移上去才出现。
    conversationUi.metaOpacity !== "0" ||
    conversationUi.moreOpacity !== "0" ||
    !/测试对话/.test(conversationUi.title) ||
    conversationUi.messages < 2 ||
    // 头部是两个图标按钮：侧边栏开关 + 新建对话，且不再有文字按钮和那句说明。
    conversationUi.headerButtonIds.join(",") !== "toggleConversations,newConversation" ||
    !/panel-left/.test(conversationUi.headerIcons[0]) ||
    !/square-pen/.test(conversationUi.headerIcons[1]) ||
    !conversationUi.noteGone ||
    !conversationUi.textButtonGone
  ) {
    throw new Error(`Conversation drawer is not ready: ${JSON.stringify(conversationUi)}`);
  }

  await page.click("#newConversation");
  const afterNew = await page.evaluate(() => ({
    count: document.querySelectorAll(".conversation-item").length,
    messages: document.querySelectorAll("#chatMessages .chat-message").length,
    label: document.querySelector("#chatConversationLabel")?.textContent.trim() || ""
  }));
  if (afterNew.count !== 2 || afterNew.messages !== 0 || afterNew.label !== "新对话") {
    throw new Error(`New conversation did not start empty: ${JSON.stringify(afterNew)}`);
  }

  await page.click(".conversation-item:nth-child(2) .conversation-open");
  const afterSwitch = await page.evaluate(() => ({
    messages: document.querySelectorAll("#chatMessages .chat-message").length,
    activeTitle: document
      .querySelector(".conversation-item.is-active .conversation-title")
      ?.textContent.trim() || ""
  }));
  if (afterSwitch.messages < 2 || !/测试对话/.test(afterSwitch.activeTitle)) {
    throw new Error(`Switching conversation did not restore its messages: ${JSON.stringify(afterSwitch)}`);
  }

  // 悬停那一行才会出现“...”，点开是置顶 / 重命名 / 删除。
  const secondRow = page.locator(".conversation-item").nth(1);
  await secondRow.hover();
  const hoverState = await page.evaluate(() => ({
    metaOpacity: getComputedStyle(
      document.querySelectorAll(".conversation-item")[1].querySelector(".conversation-meta")
    ).opacity,
    moreOpacity: getComputedStyle(
      document.querySelectorAll(".conversation-item")[1].querySelector(".conversation-more")
    ).opacity
  }));
  // 淡入有 120ms 过渡，取近似值即可。
  if (Number(hoverState.metaOpacity) < 0.9 || Number(hoverState.moreOpacity) < 0.9) {
    throw new Error(`Hovering a row must reveal count, time and the menu: ${JSON.stringify(hoverState)}`);
  }
  // 三个点必须在按钮里居中，否则看起来是歪的。
  const moreCentering = await page.evaluate(() => {
    const button = document.querySelectorAll(".conversation-more")[1];
    const icon = button.querySelector("svg, [data-lucide]");
    const buttonRect = button.getBoundingClientRect();
    const iconRect = icon.getBoundingClientRect();
    const buttonStyle = getComputedStyle(button);
    const rowRect = button.closest(".conversation-item").getBoundingClientRect();
    return {
      leftGap: iconRect.left - buttonRect.left,
      rightGap: buttonRect.right - iconRect.right,
      topGap: iconRect.top - buttonRect.top,
      bottomGap: buttonRect.bottom - iconRect.bottom,
      display: buttonStyle.display,
      justifyItems: buttonStyle.justifyItems,
      padding: `${buttonStyle.paddingLeft}/${buttonStyle.paddingRight}`,
      buttonWidth: buttonRect.width,
      iconWidth: iconRect.width,
      iconTag: icon.tagName
      ,
      buttonRightGap: rowRect.right - buttonRect.right
    };
  });
  if (
    Math.abs(moreCentering.leftGap - moreCentering.rightGap) > 1.5 ||
    Math.abs(moreCentering.topGap - moreCentering.bottomGap) > 1.5 ||
    // 按钮整体也不能贴着边框：和行右边留出一点距离。
    moreCentering.buttonRightGap < 6
  ) {
    throw new Error(`The ellipsis button is off centre: ${JSON.stringify(moreCentering)}`);
  }
  await secondRow.locator("[data-conversation-menu]").click();
  await page.locator("#chatPanel").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "chat-conversation-menu.png")
  });
  const menuItems = await page.evaluate(() => {
    const panel = [...document.querySelectorAll("[data-conversation-menu-panel]")].find(
      (item) => !item.hidden
    );
    return panel
      ? [...panel.querySelectorAll("button")].map((button) => button.textContent.trim())
      : [];
  });
  if (menuItems.join(",") !== "置顶,重命名,删除") {
    throw new Error(`Conversation menu is not pin/rename/delete: ${JSON.stringify(menuItems)}`);
  }

  await page.click("[data-conversation-menu-panel]:not([hidden]) [data-conversation-rename]");
  await page.fill(".conversation-rename-input", "喜茶对比");
  await page.keyboard.press("Enter");
  const afterRename = await page.evaluate(() => ({
    label: document.querySelector("#chatConversationLabel")?.textContent.trim() || "",
    title: document
      .querySelector(".conversation-item.is-active .conversation-title")
      ?.textContent.trim() || ""
  }));
  if (afterRename.title !== "喜茶对比" || afterRename.label !== "喜茶对比") {
    throw new Error(`Renaming a conversation failed: ${JSON.stringify(afterRename)}`);
  }

  // 置顶：被置顶的对话会排到最前面，并带一个图钉标记。
  await secondRow.hover();
  await secondRow.locator("[data-conversation-menu]").click();
  await page.click("[data-conversation-menu-panel]:not([hidden]) [data-conversation-pin]");
  const afterPin = await page.evaluate(() => {
    const first = document.querySelector(".conversation-item");
    return {
      pinned: first.classList.contains("is-pinned"),
      title: first.querySelector(".conversation-title")?.textContent.trim() || "",
      pinIcon: Boolean(first.querySelector(".conversation-pin, svg.lucide-pin"))
    };
  });
  if (!afterPin.pinned || !/喜茶对比/.test(afterPin.title) || !afterPin.pinIcon) {
    throw new Error(`Pinning a conversation failed: ${JSON.stringify(afterPin)}`);
  }
  // 取消置顶：对已置顶的那一行操作，图钉应该消失。
  const pinnedRow = page.locator(".conversation-item.is-pinned").first();
  await pinnedRow.hover();
  await pinnedRow.locator("[data-conversation-menu]").click();
  const unpinLabel = await page
    .locator("[data-conversation-menu-panel]:not([hidden]) [data-conversation-pin] span")
    .innerText();
  await page.click("[data-conversation-menu-panel]:not([hidden]) [data-conversation-pin]");
  const afterUnpin = await page.evaluate(() => ({
    pinnedCount: document.querySelectorAll(".conversation-item.is-pinned").length,
    titles: [...document.querySelectorAll(".conversation-title")].map((node) =>
      node.textContent.trim()
    )
  }));
  if (unpinLabel !== "取消置顶" || afterUnpin.pinnedCount !== 0) {
    throw new Error(
      `Unpinning a conversation failed: ${JSON.stringify({ unpinLabel, afterUnpin })}`
    );
  }

  // 删掉那个空的“新对话”，当前对话（喜茶对比）应该留在原地。
  const emptyRow = page.locator(".conversation-item").filter({ hasText: "新对话" });
  await emptyRow.hover();
  await emptyRow.locator("[data-conversation-menu]").click();
  await page.click("[data-conversation-menu-panel]:not([hidden]) [data-conversation-delete]");
  const confirmState = await page.evaluate(
    () =>
      document
        .querySelector("[data-conversation-menu-panel]:not([hidden]) [data-conversation-delete] span")
        ?.textContent.trim() || ""
  );
  await page.click("[data-conversation-menu-panel]:not([hidden]) [data-conversation-delete]");
  const afterDelete = await page.evaluate(() => ({
    count: document.querySelectorAll(".conversation-item").length,
    messages: document.querySelectorAll("#chatMessages .chat-message").length
  }));
  if (
    !/确认删除/.test(confirmState) ||
    afterDelete.count !== 1 ||
    afterDelete.messages < 2
  ) {
    throw new Error(`Deleting a conversation failed: ${JSON.stringify({ confirmState, afterDelete })}`);
  }
  await page.locator("#chatPanel").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "chat-conversations.png")
  });
  await page.click("#closeChat");

  for (let run = 2; run <= 3; run += 1) {
    await page.click("#fillExample");
    await page.click("#startAnalysis");
    await confirmQuestionReview(
      page,
      `自定义问题 ${run}：小米 14 和 iPhone 17 Pro 的续航谁更强？`
    );
    await page.waitForFunction(() => {
      const status = document.querySelector("#processStatus")?.textContent || "";
      const label = document.querySelector("#startAnalysis span")?.textContent || "";
      return status.includes("分析完成") && !label.includes("正在检测");
    }, null, { timeout: 8000 });
  }
  // Two more analyses ran after the conversation tests: the chat must still be
  // there, with the same conversation and its renamed title.
  const chatSurvivedAnalyses = await page.evaluate(() => {
    const panel = document.querySelector("#chatPanel");
    panel.hidden = false;
    const result = {
      messages: document.querySelectorAll("#chatMessages .chat-message").length,
      label: document.querySelector("#chatConversationLabel")?.textContent.trim() || "",
      conversations: document.querySelectorAll(".conversation-item").length
    };
    panel.hidden = true;
    return result;
  });
  if (
    chatSurvivedAnalyses.messages < 2 ||
    chatSurvivedAnalyses.label !== "喜茶对比" ||
    chatSurvivedAnalyses.conversations !== 1
  ) {
    throw new Error(
      `Generating questions or running an analysis cleared the chat: ${JSON.stringify(
        chatSurvivedAnalyses
      )}`
    );
  }
  // 免注册的产品没有账号体系：注册、邀请、分享和每周监控的入口已经全部移除，
  // 免费的额度用完后的行为在脚本末尾单独验证。

  // A finished report can be re-tested with edited questions, without going
  // back to the workspace, and the brand rule is enforced while editing.
  await page.click("#editQuestions");
  const editState = await page.evaluate(() => ({
    disabled: document.querySelector('[data-question-index="0"]').disabled,
    label: document.querySelector("#confirmQuestions span").textContent.trim(),
    coverageVisible: !document.querySelector("#questionCoverage").hidden
  }));
  if (
    editState.disabled ||
    !/重新测试/.test(editState.label) ||
    !editState.coverageVisible
  ) {
    throw new Error(`Re-test entry point is not usable: ${JSON.stringify(editState)}`);
  }

  await page.fill('[data-question-index="0"]', "随便改一个问题？");
  await page.click("#confirmQuestions");
  const guardMessage = await page.locator("#questionReviewError").innerText();
  if (!guardMessage.includes("每题都需要包含你的品牌")) {
    throw new Error(`Brand rule did not block the run: ${guardMessage}`);
  }

  await page.fill(
    '[data-question-index="0"]',
    "修改后的问题：小米 14 和 iPhone 17 Pro 的续航谁更强？"
  );
  await page.click("#confirmQuestions");
  await page.waitForFunction(
    () => {
      const status = document.querySelector("#processStatus")?.textContent || "";
      const label = document.querySelector("#startAnalysis span")?.textContent || "";
      return status.includes("分析完成") && !label.includes("正在检测");
    },
    null,
    { timeout: 8000 }
  );
  const retestReport = await page.evaluate(
    () => document.querySelector("#questionTable").textContent
  );
  if (!retestReport.includes("修改后的问题")) {
    throw new Error("Re-test did not use the edited questions");
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "mobile.png"),
    fullPage: true
  });
  await page.click("#chatToggle");
  await page.waitForSelector("#chatPanel:not([hidden])");
  const mobileChat = await page.evaluate(() => {
    const panel = document.querySelector("#chatPanel").getBoundingClientRect();
    return { width: panel.width, height: panel.height };
  });
  if (mobileChat.width < 360 || mobileChat.height < 560) {
    throw new Error("Mobile AnswerLens Copilot panel is too small");
  }
  await page.click("#closeChat");

  const horizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  if (horizontalOverflow) throw new Error("Mobile layout has horizontal overflow");
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  const overlap = await page.evaluate(() => {
    const button = document.querySelector("#chatToggle").getBoundingClientRect();
    const fold = document.querySelector("#notes summary svg").getBoundingClientRect();
    const intersects = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    return intersects(button, fold);
  });
  if (overlap) throw new Error("Floating assistant overlaps the note fold");

  // 额度用完时不再弹注册框：按钮直接禁用，并给出恢复时间。
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    const today = new Date();
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(
      today.getDate()
    ).padStart(2, "0")}`;
    localStorage.setItem("visiblegrow.quota", JSON.stringify({ date: key, remaining: 0 }));
  });
  await page.reload();
  await page.waitForSelector("#workspace");
  const exhausted = await page.evaluate(() => ({
    quota: document.querySelector("#quotaText").textContent.trim(),
    disabled: document.querySelector("#startAnalysis").disabled,
    label: document.querySelector("#startAnalysis span").textContent.trim(),
    dialogs: document.querySelectorAll("dialog").length,
    registerEntry: Boolean(document.querySelector("#headerRegister"))
  }));
  if (
    !/今日免费额度已用完/.test(exhausted.quota) ||
    !exhausted.disabled ||
    exhausted.label !== "今日额度已用完" ||
    exhausted.dialogs !== 0 ||
    exhausted.registerEntry
  ) {
    throw new Error(
      `Exhausted quota still falls back to a registration flow: ${JSON.stringify(exhausted)}`
    );
  }
  await page.locator(".form-actions").screenshot({
    path: path.join(__dirname, "..", "qa", "ui", "quota-exhausted.png")
  });

  if (errors.length) throw new Error(`Browser errors: ${errors.join(" | ")}`);

  await browser.close();
  console.log("visual smoke passed: desktop and mobile flows");
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
