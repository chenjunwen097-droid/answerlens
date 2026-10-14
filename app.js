(function () {
  const core = window.VisibilityCore;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const elements = {
    brandInput: $("#brandInput"),
    brandProductInput: $("#brandProductInput"),
    competitorInputs: $$(".competitor-input"),
    competitorProductInputs: $$(".competitor-product-input"),
    directionCheckboxes: $$(".direction-checkbox"),
    otherInput: $("#otherInput"),
    analysisForm: $("#analysisForm"),
    startAnalysis: $("#startAnalysis"),
    formError: $("#formError"),
    timeline: $("#timeline"),
    processStatus: $("#processStatus"),
    process: $("#process"),
    report: $("#report"),
    reportTitle: $("#reportTitle"),
    scoreRing: $("#scoreRing"),
    scoreValue: $("#scoreValue"),
    scoreHeadline: $("#scoreHeadline"),
    scoreSummary: $("#scoreSummary"),
    mentionMetric: $("#mentionMetric"),
    firstChoiceMetric: $("#firstChoiceMetric"),
    scoringStandard: $("#scoringStandard"),
    scoringStandardBody: $("#scoringStandardBody"),
    competitorChart: $("#competitorChart"),
    questionTable: $("#questionTable"),
    positioningSummary: $("#positioningSummary"),
    recommendationList: $("#recommendationList"),
    quotaText: $("#quotaText"),
    toast: $("#toast"),
    chatPanel: $("#chatPanel"),
    chatImageInput: $("#chatImageInput"),
    chatMessages: $("#chatMessages"),
    chatConversationLabel: $("#chatConversationLabel"),
    chatConversations: $("#chatConversations"),
    conversationList: $("#conversationList"),
    newConversation: $("#newConversation"),
    toggleConversations: $("#toggleConversations"),
    navProcess: $("#navProcess"),
    navReport: $("#navReport"),
    questionReviewStatus: $("#questionReviewStatus"),
    questionEditorList: $("#questionEditorList"),
    questionReviewError: $("#questionReviewError"),
    questionCoverage: $("#questionCoverage"),
    regenerateQuestions: $("#regenerateQuestions"),
    confirmQuestions: $("#confirmQuestions"),
    editQuestions: $("#editQuestions"),
    retryFailedAnswers: $("#retryFailedAnswers")
  };

  // A flat daily allowance keeps the tool usable without accounts.
  const DAILY_LIMIT = 6;

  let activeReport = null;
  let toastTimer;
  let analysisTimer = [];
  let pendingQuestions = [];
  let remainingQuota = DAILY_LIMIT;
  let analysisRunning = false;
  let awaitingQuestionConfirmation = false;
  let hasRun = false;
  // Conversations own the chat: only the user creates, switches or deletes one.
  // Generating questions and running an analysis leave them untouched.
  let conversations = [];
  let activeConversationId = null;
  let pendingImage = null;
  let analysisDraft = null;
  let analysisRetryState = null;
  // Verdicts are kept between a retry so the same answer is never judged twice.
  let analysisJudgments = {};

  const STORAGE_KEYS = {
    quota: "visiblegrow.quota",
    conversations: "visiblegrow.conversations"
  };

  function isApiMode() {
    return /^https?:$/.test(window.location.protocol);
  }

  function todayKey() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${now.getFullYear()}-${month}-${day}`;
  }

  function loadQuota() {
    try {
      const quota = JSON.parse(localStorage.getItem(STORAGE_KEYS.quota) || "null");
      if (quota?.date === todayKey() && Number.isFinite(quota?.remaining)) {
        remainingQuota = Math.max(0, Math.min(DAILY_LIMIT, quota.remaining));
        return;
      }
    } catch {
      localStorage.removeItem(STORAGE_KEYS.quota);
    }
    remainingQuota = DAILY_LIMIT;
    persistQuota();
  }

  function persistQuota() {
    localStorage.setItem(
      STORAGE_KEYS.quota,
      JSON.stringify({ date: todayKey(), remaining: remainingQuota })
    );
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.add("is-visible");
    toastTimer = setTimeout(() => elements.toast.classList.remove("is-visible"), 2400);
  }

  function createIcon(name) {
    return `<i data-lucide="${name}"></i>`;
  }

  function refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function updateQuota() {
    const locked = !core.canAnalyze(remainingQuota);
    elements.quotaText.textContent = core.quotaLabel(remainingQuota, DAILY_LIMIT);
    elements.quotaText.classList.toggle("is-empty", locked);
    elements.startAnalysis.disabled = locked || analysisRunning || awaitingQuestionConfirmation;
    const buttonLabel = $("span", elements.startAnalysis);
    if (awaitingQuestionConfirmation) buttonLabel.textContent = "请确认买家问题";
    else if (analysisRunning) buttonLabel.textContent = "正在检测…";
    else if (locked) buttonLabel.textContent = "今日额度已用完";
    else buttonLabel.textContent = hasRun ? "重新检测" : "开始检测";
  }

  function renderTimeline(items, completed = true) {
    elements.timeline.innerHTML = items
      .map(
        (item, index) => `
          <article class="timeline-item ${completed ? "is-complete" : "is-pending"}" data-step="${index}">
            <strong>${item.label}</strong>
            <p>${item.detail}</p>
          </article>
        `
      )
      .join("");
  }

  function renderScoringStandard(report) {
    const dimensions = report?.scoringStandard || core.SCORE_DIMENSIONS || [];
    elements.scoringStandardBody.innerHTML = `
      <div class="scoring-block">
        <span class="scoring-block-kicker">计分公式</span>
        <div class="scoring-formula">
          单题得分 = ${dimensions
            .map((item) => `${item.label} × ${item.weight}%`)
            .join(" + ")}
        </div>
        <p class="scoring-note">
          某个维度在这道题里无法判定时（例如回答没有给出推荐顺序、也没有事实主张），该维度不参与加权，分母按其余维度重新计算。
        </p>
      </div>
      <div class="scoring-block">
        <span class="scoring-block-kicker">五个维度怎么判定</span>
        <div class="scoring-dimension-list">
          ${dimensions
            .map(
              (item) => `
                <div>
                  <strong>${escapeHtml(item.label)}</strong>
                  <span>${item.weight}%</span>
                  <p>${escapeHtml(item.description)}</p>
                  ${item.rule ? `<p class="scoring-rule">${escapeHtml(item.rule)}</p>` : ""}
                  ${
                    item.formula
                      ? `<p class="scoring-rule scoring-formula-line">公式：${escapeHtml(
                          item.formula
                        )}</p>`
                      : ""
                  }
                  ${
                    Array.isArray(item.values) && item.values.length
                      ? `<p class="scoring-rule scoring-tier-line">档位：${item.values
                          .map((value) => `<b>${escapeHtml(value)}</b>`)
                          .join("")}${
                          item.valuesNote
                            ? `<em>${escapeHtml(item.valuesNote)}</em>`
                            : ""
                        }</p>`
                      : ""
                  }
                </div>
              `
            )
            .join("")}
        </div>
      </div>
      <div class="scoring-block">
        <span class="scoring-block-kicker">判定依据</span>
        <p class="scoring-evidence-note">
          每个维度都由评分模型逐条判定，并附上它依据的回答原句；在“提问明细”里展开任意一条回答的“判定依据”，即可看到每个维度为什么得这个分。
        </p>
      </div>
      <div class="scoring-block">
        <span class="scoring-block-kicker">备用口径 · 规则判定</span>
        <p class="scoring-note">
          某条回答的逐条判定用不了时（请求超时、返回内容不合法，或引用的句子在回答里找不到），这条回答改用下面的固定规则计分，并在“判定依据”里标注“规则判定”。
        </p>
        <ul class="scoring-rule-list">
          <li><b>推荐出现</b><span>回答里出现该对象名称（含简称、英文名、产品名）记 100，否则记 0。</span></li>
          <li><b>推荐顺位</b><span>按名称在回答中首次出现的位置排序：第 1 个出现 100、第 2 个 75、第 3 个 50、第 4 个及以后 25。</span></li>
          <li><b>描述倾向</b><span>在提到该对象的那句话里匹配正面词（推荐、优势、适合、领先、更强…）与负面词（短板、不推荐、缺点、风险、劣势…）：正面 100、负面 20、都不命中 60。</span></li>
          <li><b>证据完整</b><span>该句话里存在可引用的原文片段记 100，没有记 0。</span></li>
          <li><b>竞品差异</b><span>同一条回答里还提到其他对象记 100，否则记 60。</span></li>
        </ul>
        <p class="scoring-note">
          规则判定比逐条判定粗糙（例如否定句里的名称也会算作提及），所以它只作为兜底，不用于判定可用的回答。
        </p>
      </div>
      <div class="scoring-block">
        <span class="scoring-block-kicker">总分</span>
        <p class="scoring-total-formula">AI 推荐表现总分 = 被问到的题目得分之和 ÷ 被问到的题数（你的品牌每题都会被问到，固定按 6 题计算）</p>
      </div>
    `;
    const minAsked = Number(report?.minAskedQuestions) || core.MIN_ASKED_QUESTIONS;
    const minRankable =
      Number(report?.rankingMinQuestions) || core.RANKING_MIN_QUESTIONS;
    const sampleRule = $("#scoringSampleRule");
    if (sampleRule) {
      const lowRange =
        minRankable - 1 === minAsked
          ? `${minAsked} 题`
          : `${minAsked}–${minRankable - 1} 题`;
      sampleRule.innerHTML = `
        <p class="scoring-sample-lead">
          每个对象只按“被问到它的题目”计分——你的品牌每题都会被问到，每个竞品至少出现在 ${core.MIN_COMPETITOR_COVERAGE} 题。
        </p>
        <ul class="scoring-rule-list">
          <li><b>覆盖 ${minRankable} 题及以上</b><span>正常计分并参与排名。</span></li>
          <li><b>覆盖 ${lowRange}</b><span>仍然计分，但标记“样本偏少”，不参与排名。</span></li>
          <li><b>覆盖少于 ${minAsked} 题</b><span>标记“样本不足”，不计算得分、不参与排名，明细中显示“-”。</span></li>
        </ul>
      `;
    }
  }

  function reportEntityLookup(report) {
    const lookup = {};
    (report?.entityStats || []).forEach((item) => {
      lookup[item.id] = { name: item.name, type: item.type };
    });
    if (!lookup.brand) {
      lookup.brand = { name: report?.brand || "你的品牌", type: "brand" };
    }
    (report?.competitors || []).forEach((name, index) => {
      const id = `competitor_${index + 1}`;
      if (!lookup[id]) lookup[id] = { name, type: "competitor" };
    });
    return lookup;
  }

  // The itemised verdicts behind one answer. Collapsed by default so the report
  // stays calm, but every dimension can be checked against the sentence it was
  // judged from.
  function answerRationaleMarkup(observation, report) {
    const judge = observation?.judgments || {};
    const ids = Object.keys(judge);
    const judgedReport = Boolean(report?.judge);
    if (!ids.length && !judgedReport) return "";
    if (!ids.length) {
      return `
        <details class="answer-rationale">
          <summary><i data-lucide="chevron-down"></i>判定依据<span>规则判定</span></summary>
          <div class="answer-rationale-body">
            <p class="rationale-note">这条回答的逐条判定本次不可用，已改用规则判定（名称匹配与出现位置）。</p>
          </div>
        </details>
      `;
    }
    const lookup = reportEntityLookup(report);
    const dimensions = report?.scoringStandard || core.SCORE_DIMENSIONS || [];
    const entities = ids
      .map((id) => {
        const entry = judge[id] || {};
        const entity = lookup[id] || { name: id, type: "competitor" };
        const rows = dimensions
          .map((dimension) => {
            const applicable = entry.applicable?.[dimension.key] !== false;
            const value = Number(entry.dimensions?.[dimension.key] ?? 0);
            const reason = entry.reasons?.[dimension.key] || "";
            return `
              <li>
                <span class="rationale-dim">${escapeHtml(dimension.label)}</span>
                <b class="rationale-value${applicable ? "" : " is-na"}">${
                  applicable ? value : "不参与"
                }</b>
                <span class="rationale-reason">${escapeHtml(reason || "—")}</span>
              </li>
            `;
          })
          .join("");
        return `
          <div class="rationale-entity">
            <strong>${escapeHtml(entity.name)}<span>${
              entity.type === "brand" ? "品牌" : "竞品"
            }</span></strong>
            <ul>${rows}</ul>
            ${
              entry.quote
                ? `<p class="rationale-quote">“${escapeHtml(entry.quote)}”</p>`
                : ""
            }
          </div>
        `;
      })
      .join("");
    return `
      <details class="answer-rationale">
        <summary><i data-lucide="chevron-down"></i>判定依据<span>模型逐条判定</span></summary>
        <div class="answer-rationale-body">${entities}</div>
      </details>
    `;
  }

  function renderReport(report) {
    if (!report) return;
    activeReport = report;
    const scoreAvailable = report.score !== null && report.score !== undefined;
    const score = scoreAvailable ? core.formatScore(report.score) : "--";
    elements.reportTitle.textContent = `${report.brand} 的 AI 推荐情报报告`;
    $(".report-topline p").textContent = `检测完成于 ${new Date().toLocaleDateString("zh-CN")} · ${
      report.isReal ? "真实模型数据" : "本地模拟数据"
    } · ${report.modelStats?.length || 2} 个模型`;
    elements.scoreValue.textContent = score;
    elements.scoreRing.style.background = `conic-gradient(var(--orange) 0 ${
      scoreAvailable ? score : 0
    }%, #ddd8d0 ${scoreAvailable ? score : 0}% 100%)`;
    elements.scoreHeadline.textContent = !scoreAvailable
      ? "样本不足，无法给出推荐表现"
      : Number(score) >= 75
        ? "产品已经成为 AI 推荐中的重要选项"
        : Number(score) >= 55
          ? "AI 能理解产品，但推荐理由还不够稳定"
          : "AI 对产品的理解和推荐仍然有限";
    elements.scoreSummary.textContent = scoreAvailable
      ? `${report.brand} 的 AI 推荐表现平均分为 ${score}/100，共分析 ${report.totalQuestions} 个决策问题和 12 条真实回答。`
      : `${report.brand} 出现的问题少于 2 个，样本不足，无法计算 AI 推荐表现。请检查买家问题是否都包含你的品牌。`;
    const recommendationRate = report.metrics?.recommendationRate;
    elements.mentionMetric.textContent =
      recommendationRate === null || recommendationRate === undefined
        ? "--"
        : `${recommendationRate}%`;
    const firstChoiceRate = report.metrics?.firstChoiceRate;
    elements.firstChoiceMetric.textContent =
      firstChoiceRate === null || firstChoiceRate === undefined ? "--" : `${firstChoiceRate}%`;
    renderScoringStandard(report);

    // Ranked entities come first in rank order; anything measured on too few
    // questions is listed after them and never competes for a rank.
    const rankById = new Map(
      (report.ranking || []).map((item) => [item.id, item.rank])
    );
    const rankedRows = [...(report.matrix || [])].sort((a, b) => {
      const rankA = rankById.get(a.id);
      const rankB = rankById.get(b.id);
      if (rankA && rankB) return rankA - rankB;
      if (rankA) return -1;
      if (rankB) return 1;
      return 0;
    });
    elements.competitorChart.innerHTML = rankedRows
      .map((item) => {
        const insufficient = Boolean(item.insufficient) || item.value === null;
        const rankable = !insufficient && item.rankable !== false;
        const rank = rankById.get(item.id);
        const value = insufficient ? 0 : Number(item.value);
        const notes = [];
        if (Number.isFinite(Number(item.asked))) {
          notes.push(`覆盖 ${item.asked}/${report.totalQuestions}`);
        }
        if (insufficient) notes.push("样本不足");
        else if (!rankable) notes.push(`样本偏少 · 不参与排名`);
        const badge = rank
          ? `<b class="bar-rank">#${rank}</b>`
          : `<b class="bar-rank is-muted">—</b>`;
        return `
          <div class="bar-row${rankable ? "" : " is-insufficient"}">
            <span>${badge}${escapeHtml(item.name)}<em class="bar-coverage">${notes.join(
              " · "
            )}</em></span>
            <div class="bar-track"><div class="bar-fill" style="--value:${value}%"></div></div>
            <strong>${insufficient ? "-" : value}</strong>
          </div>
        `;
      })
      .join("");

    const questionStats = report.questionStats || [];
    const observations = report.observations || [];
    const scoringDimensions = report.scoringStandard || core.SCORE_DIMENSIONS || [];
    const entityColumns = [
      { id: "brand", name: report.brand || "你的品牌", isBrand: true },
      ...(report.competitors || []).map((name, index) => ({
        id: `competitor_${index + 1}`,
        name,
        isBrand: false
      }))
    ];
    const scoreFormula = scoringDimensions
      .map((dimension) => `${dimension.label} × ${dimension.weight}%`)
      .join(" + ");
    elements.questionTable.innerHTML = `
      <div class="question-table-head">
        <span class="question-head-index" aria-hidden="true"></span>
        <span class="question-head-title">买家问题</span>
        <span class="question-head-score">AI 推荐表现</span>
      </div>
      ${report.questions
        .map((question, index) => {
          const stat = questionStats[index] || {
            mentioned: false,
            sentiment: "neutral"
          };
          const answers = observations.filter((item) => item.questionIndex === index);
          const entityScores = stat.entityScores || {};
          // "-" means the question never asked about this entity (not
          // applicable). A real 0 means it was asked but the models
          // ignored it, which is a finding worth keeping visible.
          const cellMarkup = (column, key) => {
            const entity = entityScores[column.id];
            if (entity && entity.applicable === false) {
              return '<td class="score-na">-</td>';
            }
            if (entity) {
              const value = Number(entity[key] ?? 0);
              const ignored = value === 0 && !entity.mentioned;
              return `<td${column.isBrand ? ' class="is-brand"' : ""}>${value}${
                ignored ? '<span class="score-ignored">未被提及</span>' : ""
              }</td>`;
            }
            // Older/mock reports have no per-entity scores at all.
            if (column.isBrand) {
              return `<td class="is-brand">${Number(stat.dimensions?.[key] ?? 0)}</td>`;
            }
            return '<td class="score-na">-</td>';
          };
          const totalMarkup = (column) => {
            const entity = entityScores[column.id];
            if (entity && entity.applicable === false) {
              return '<td class="score-na">-</td>';
            }
            if (entity) {
              return `<td${column.isBrand ? ' class="is-brand"' : ""}>${Number(
                entity.score ?? 0
              )}</td>`;
            }
            return column.isBrand
              ? `<td class="is-brand">${Number(stat.score ?? 0)}</td>`
              : '<td class="score-na">-</td>';
          };
          const comparisonRows = scoringDimensions
            .map(
              (dimension) => `
                <tr>
                  <th scope="row">
                    ${escapeHtml(dimension.label)}
                    <span>${dimension.weight}%</span>
                  </th>
                  ${entityColumns
                    .map((column) => cellMarkup(column, dimension.key))
                    .join("")}
                </tr>
              `
            )
            .join("");
          const entityHead = (column) => {
            // No full-width brackets here: U+FF09 carries a right side bearing
            // that made the role line look offset from the name above it.
            const entity = report.entityStats?.find((item) => item.id === column.id);
            const role = column.isBrand ? "品牌" : "竞品";
            const tier = !entity
              ? ""
              : entity.insufficient
                ? " · 样本不足 · 不参与排名"
                : entity.rankable === false
                  ? " · 样本偏少 · 不参与排名"
                  : "";
            const coverage = entity
              ? `<span class="score-coverage">覆盖 ${entity.askedQuestions}/${entity.totalQuestions}${tier}</span>`
              : "";
            return (
              `<th scope="col"${column.isBrand ? ' class="is-brand"' : ""}>` +
              `<strong>${escapeHtml(column.name)}</strong>` +
              `<span class="score-entity-role">${role}</span>${coverage}` +
              `</th>`
            );
          };
          return `
            <section class="question-evidence">
              <div class="question-summary-row">
                <span class="question-index">0${index + 1}</span>
                <strong>${escapeHtml(question)}</strong>
                <button
                  type="button"
                  class="question-score-button"
                  data-score-index="${index}"
                  aria-expanded="false"
                  aria-controls="scoreBreakdown${index}"
                >
                  <span class="question-score-value">${stat.score ?? 0}</span>
                  <span class="question-score-toggle">
                    <i data-lucide="chevron-down"></i>
                    <span>得分明细</span>
                  </span>
                </button>
              </div>
              <div
                class="score-breakdown"
                id="scoreBreakdown${index}"
                data-score-breakdown="${index}"
                hidden
              >
                <p class="score-breakdown-formula">单题得分 = ${escapeHtml(scoreFormula)}</p>
                <div class="score-table">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">维度</th>
                        ${entityColumns.map((column) => entityHead(column)).join("")}
                      </tr>
                    </thead>
                    <tbody>${comparisonRows}</tbody>
                    <tfoot>
                      <tr>
                        <th scope="row">本题合计</th>
                        ${entityColumns.map((column) => totalMarkup(column)).join("")}
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p class="score-breakdown-note">
                  维度得分为 0–100，本题合计 = 各维度得分按上方权重加权后四舍五入；无法判定的维度不参与加权，分母按其余维度重新计算。
                  每个维度的判定依据见下方每条回答的“判定依据”。
                </p>
              </div>
              <div class="answer-grid">
                ${answers
                  .map(
                    (answer) => `
                      <article class="answer-card">
                        <header>
                          <strong>${escapeHtml(answer.model || answer.provider)}</strong>
                        </header>
                        <div class="answer-content">${renderMarkdown(answer.answer || "")}</div>
                        ${answerRationaleMarkup(answer, report)}
                      </article>
                    `
                  )
                  .join("")}
              </div>
            </section>
          `;
        })
        .join("")}
    `;

    const positioning = report.positioning || {};
    const positioningBlocks = [
      { key: "headline", label: "一句话定位" },
      { key: "consensus", label: "模型共识" },
      { key: "differentiators", label: "与竞品的关键差异" }
    ].filter((item) => String(positioning[item.key] || "").trim());
    const detectedConflicts = Array.isArray(positioning.conflicts)
      ? positioning.conflicts
      : [];
    const positioningParts = positioningBlocks.map(
      (item) => `
        <div class="positioning-item">
          <strong>${item.label}</strong>
          <p>${escapeHtml(core.cleanAssistantText(positioning[item.key]))}</p>
        </div>
      `
    );
    if (detectedConflicts.length) {
      const conflictItems = detectedConflicts
        .map((conflict) => {
          const sides = (conflict.sides || [])
            .map(
              (side) => `
                <blockquote>
                  <strong>${escapeHtml(side.model || side.provider || "")}</strong>
                  <span>${escapeHtml(core.cleanAssistantText(side.quote || ""))}</span>
                </blockquote>
              `
            )
            .join("");
          const summary =
            conflict.summary ||
            `${conflict.entityName} 的描述在两个模型之间不一致`;
          return `
            <div class="positioning-conflict">
              <p class="positioning-conflict-summary">${escapeHtml(
                core.cleanAssistantText(summary)
              )}</p>
              <div class="positioning-conflict-sides">${sides}</div>
            </div>
          `;
        })
        .join("");
      positioningParts.push(`
        <div class="positioning-item">
          <strong>模型描述冲突</strong>
          ${conflictItems}
        </div>
      `);
    }
    // One model answered, the other never mentioned the product: AI coverage is
    // partial, which is a different problem from a description conflict.
    const coverageGaps = Array.isArray(report.positioning?.coverageGaps)
      ? report.positioning.coverageGaps
      : [];
    if (coverageGaps.length) {
      const gapItems = coverageGaps
        .map(
          (gap) => `
            <div class="positioning-gap">
              <p class="positioning-gap-summary">
                第 ${Number(gap.questionIndex) + 1} 题 · ${escapeHtml(gap.entityName)}
              </p>
              <div class="positioning-conflict-sides">
                ${(gap.sides || [])
                  .map(
                    (side) => `
                      <blockquote${side.mentioned ? "" : ' class="is-missing"'}>
                        <strong>${escapeHtml(side.model || side.provider || "")}</strong>
                        <span>${
                          side.mentioned
                            ? escapeHtml(core.cleanAssistantText(side.quote || ""))
                            : "这一题没有提到该产品"
                        }</span>
                      </blockquote>
                    `
                  )
                  .join("")}
              </div>
            </div>
          `
        )
        .join("");
      positioningParts.push(`
        <div class="positioning-item">
          <strong>模型覆盖不一致</strong>
          <p class="positioning-gap-note">
            同一道题里有一个模型提到了你的产品、另一个完全没提到——这说明 AI 对你的覆盖是不完整的。
          </p>
          ${gapItems}
        </div>
      `);
    }
    elements.positioningSummary.innerHTML = positioningParts.length
      ? positioningParts.join("")
      : `<p class="positioning-empty">${
          escapeHtml(report.positioningSummary) ||
          "当前原始回答不足以形成可靠的定位总结。"
        }</p>`;

    elements.recommendationList.innerHTML = (report.suggestions || [])
      .map(
        (item, index) => `
          <li>
            <span class="priority">0${index + 1}</span>
            <div class="recommendation-body">
              <section class="recommendation-analysis">
                <span class="recommendation-label">分析</span>
                <p>${escapeHtml(core.cleanAssistantText(item.analysis || item.detail || ""))}</p>
                <div class="recommendation-evidence">
                ${(item.evidence || [])
                  .map(
                    (evidence) => `
                      <blockquote>
                        <strong>${escapeHtml(evidence.model || evidence.provider || "")}</strong>
                        <span>${escapeHtml(core.cleanAssistantText(evidence.quote || ""))}</span>
                      </blockquote>
                    `
                  )
                  .join("")}
                </div>
              </section>
              <section class="recommendation-suggestion">
                <span class="recommendation-label">建议</span>
                <strong>
                  ${escapeHtml(core.cleanAssistantText(item.title))}
                  ${
                    item.source?.url
                      ? `<a
                          class="recommendation-source"
                          href="${escapeHtml(item.source.url)}"
                          target="_blank"
                          rel="noopener noreferrer"
                          title="外部来源：${escapeHtml(item.source.title || item.source.host)}"
                          aria-label="外部来源：${escapeHtml(item.source.title || item.source.host)}"
                        ><i data-lucide="globe"></i></a>`
                      : ""
                  }
                </strong>
                <p>${escapeHtml(
                  core.cleanAssistantText(item.suggestion || item.detail || "")
                )}</p>
              </section>
            </div>
          </li>
        `
      )
      .join("") ||
      '<li><strong>当前原始回答不足以形成可靠行动建议。</strong></li>';

    refreshIcons();
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function renderMarkdown(value) {
    const source = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!source) return "";
    const escaped = escapeHtml(source);
    const blocks = escaped.split(/\n{2,}/);
    return blocks
      .map((block) => {
        const lines = block.split("\n");
        if (lines[0]?.startsWith("```")) {
          const code = lines.slice(1, lines.at(-1)?.startsWith("```") ? -1 : undefined);
          return `<pre><code>${code.join("\n")}</code></pre>`;
        }
        if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
          return `<ul>${lines
            .map((line) => `<li>${inlineMarkdown(line.replace(/^\s*[-*+]\s+/, ""))}</li>`)
            .join("")}</ul>`;
        }
        if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
          return `<ol>${lines
            .map((line) => `<li>${inlineMarkdown(line.replace(/^\s*\d+\.\s+/, ""))}</li>`)
            .join("")}</ol>`;
        }
        if (/^#{1,6}\s+/.test(lines[0] || "")) {
          return `<h4>${inlineMarkdown(lines[0].replace(/^#{1,6}\s+/, ""))}</h4>`;
        }
        return `<p>${lines.map((line) => inlineMarkdown(line)).join("<br>")}</p>`;
      })
      .join("");
  }

  function inlineMarkdown(value) {
    return core.linkify(
      String(value || "")
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^_]+)__/g, "<strong>$1</strong>")
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    );
  }

  function clearAnalysisTimers() {
    analysisTimer.forEach(clearTimeout);
    analysisTimer = [];
  }

  function updateTimelineStep(index, state) {
    const item = $(`[data-step="${index}"]`, elements.timeline);
    if (!item) return;
    item.classList.remove("is-complete", "is-pending", "is-running");
    item.classList.add(`is-${state}`);
  }

  function updateTimelineLabel(index, label, detail) {
    const item = $(`[data-step="${index}"]`, elements.timeline);
    if (!item) return;
    const heading = $("strong", item);
    const description = $("p", item);
    if (heading) heading.textContent = label;
    if (description && detail) description.textContent = detail;
  }

  async function apiRequest(path, payload) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.message || "服务暂时不可用");
    }
    return data;
  }

  function markAllTimelineComplete() {
    $$(".timeline-item", elements.timeline).forEach((item) => {
      item.classList.remove("is-pending", "is-running");
      item.classList.add("is-complete");
    });
  }

  function renderQuestionReview(questions, mode = "editing") {
    elements.retryFailedAnswers.hidden = true;
    elements.confirmQuestions.hidden = false;
    const hasQuestions = Array.isArray(questions) && questions.length === 6;
    const editing = mode === "editing";
    elements.questionReviewStatus.textContent = hasQuestions
      ? mode === "confirmed"
        ? "已确认并提交"
        : hasRun
          ? "待确认（修改后重新测试）"
          : "待确认"
      : "等待生成";
    elements.questionReviewError.textContent = "";
    elements.regenerateQuestions.disabled = !hasQuestions || !editing;
    elements.confirmQuestions.disabled = !hasQuestions || !editing;
    // A finished report can be re-tested with edited questions without going
    // back to the workspace and regenerating everything.
    elements.editQuestions.hidden = !(hasQuestions && mode === "confirmed" && hasRun);
    elements.editQuestions.disabled = analysisRunning;
    const confirmLabel = $("span", elements.confirmQuestions);
    if (confirmLabel) {
      confirmLabel.textContent = hasRun ? "用修改后的问题重新测试" : "确认并开始测试";
    }
    elements.questionEditorList.innerHTML = hasQuestions
      ? questions
          .map(
            (question, index) => `
              <label class="question-editor-row">
                <span>0${index + 1}</span>
                <textarea
                  data-question-index="${index}"
                  maxlength="240"
                  aria-label="买家问题 ${index + 1}"
                  ${mode === "editing" ? "" : "disabled"}
                >${escapeHtml(question)}</textarea>
                <em class="question-editor-issue" data-question-issue="${index}"></em>
              </label>
            `
          )
          .join("")
      : '<p class="question-review-empty">生成后可在此编辑 6 个买家问题</p>';
    updateQuestionCoverage();
    refreshIcons();
  }

  // Live coverage feedback: every question should compare the brand with a
  // competitor, and every competitor needs enough questions to be scored.
  function updateQuestionCoverage() {
    const panel = elements.questionCoverage;
    if (!panel) return;
    const texts = $$("#questionEditorList textarea").map((textarea) =>
      textarea.value.trim()
    );
    const brief = analysisDraft?.brief;
    if (!brief || texts.length !== 6) {
      panel.hidden = true;
      panel.innerHTML = "";
      return;
    }
    const coverage = core.questionCoverage(brief, texts);
    const min = coverage.minCompetitorCoverage;
    const chips = coverage.entities
      .map((entity) => {
        const weak = entity.type === "brand" ? entity.count < coverage.total : entity.count < min;
        return `<span class="coverage-chip${weak ? " is-weak" : ""}">${escapeHtml(
          entity.name
        )} ${entity.count}/${coverage.total}</span>`;
      })
      .join("");
    panel.innerHTML = `
      <p class="coverage-title">覆盖情况 <small>每题都需包含你的品牌和至少一个竞品，每个竞品至少 ${min} 题</small></p>
      <div class="coverage-chips">${chips}</div>
    `;
    panel.hidden = false;

    coverage.issues.forEach((item) => {
      const target = $(`[data-question-issue="${item.index}"]`);
      if (!target) return;
      const labels = item.problems.map((problem) =>
        problem === "missing_brand"
          ? "缺少你的品牌"
          : problem === "missing_competitor"
            ? "缺少竞品"
            : problem === "empty"
              ? "内容为空"
              : problem
      );
      target.textContent = labels.join(" · ");
      target.classList.toggle("is-visible", labels.length > 0);
    });
  }

  function setQuestionReviewLocked(locked) {
    $$("#questionEditorList textarea").forEach((textarea) => {
      textarea.disabled = locked;
    });
    elements.regenerateQuestions.disabled = locked;
    elements.confirmQuestions.disabled = locked;
  }

  elements.questionEditorList.addEventListener("input", updateQuestionCoverage);

  function readConfirmedQuestions() {
    const values = $$("#questionEditorList textarea").map((textarea) =>
      textarea.value.trim()
    );
    if (values.length !== 6 || values.some((value) => !value)) {
      elements.questionReviewError.textContent = "请先补全 6 个买家问题。";
      return null;
    }
    return values;
  }

  async function prepareAnalysis(brief) {
    if (!core.canAnalyze(remainingQuota)) {
      showToast("今日免费额度已用完，明天自动恢复");
      return;
    }
    clearAnalysisTimers();
    analysisRetryState = null;
    elements.retryFailedAnswers.hidden = true;
    elements.confirmQuestions.hidden = false;
    const requestId = `analysis_${Date.now().toString(36)}`;
    const normalizedBrief = core.cleanBrief(brief);
    analysisDraft = {
      requestId,
      brief: normalizedBrief,
      questions: []
    };
    awaitingQuestionConfirmation = true;
    analysisRunning = false;
    hasRun = false;
    // The chat is not cleared here: generating questions must not touch the
    // user's conversation.
    pendingQuestions = [];
    elements.process.hidden = false;
    elements.report.hidden = true;
    elements.navProcess.hidden = false;
    elements.navReport.hidden = true;
    elements.formError.textContent = "";
    renderTimeline(
      [
        { id: "questions", label: "生成 6 个买家问题", detail: "准备中" },
        { id: "deepseek", label: "询问 DeepSeek Flash · 0/6", detail: "等待问题确认" },
        { id: "glm", label: "询问 GLM 4.6v · 0/6", detail: "等待问题确认" },
        { id: "extract", label: "提取推荐证据与产品理解", detail: "等待回答完成" },
        { id: "score", label: "生成 AI 推荐表现", detail: "等待证据归一化" }
      ],
      false
    );
    renderQuestionReview([], "loading");
    elements.processStatus.innerHTML = '<span class="status-dot"></span> 正在生成问题';
    updateQuota();
    $("#process").scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      let questions;
      if (isApiMode()) {
        const data = await fetchQuestionsWithRetry({
          phase: "questions",
          requestId,
          brief: normalizedBrief
        });
        questions = data.questions;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 180));
        questions = core.makeQuestionsForBrief(normalizedBrief);
      }
      analysisDraft.questions = questions;
      renderQuestionReview(questions, "editing");
      updateTimelineStep(0, "complete");
      updateTimelineLabel(0, "6 个买家问题已生成", "编辑并确认后才会提交测试");
      elements.processStatus.innerHTML = '<span class="status-dot"></span> 等待确认买家问题';
      updateQuota();
      refreshIcons();
    } catch (error) {
      awaitingQuestionConfirmation = false;
      renderQuestionReview([], "loading");
      elements.processStatus.innerHTML = '<span class="status-dot"></span> 问题生成失败 · 未扣次数';
      elements.formError.textContent = error.message || "问题生成失败，请稍后重试。";
      updateQuota();
    }
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Question generation is the step users cannot skip, so retry it client-side
  // as well: server restarts, cold starts and platform timeouts never reach the
  // user as a hard failure if a second attempt would have worked.
  async function fetchQuestionsWithRetry(payload, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await apiRequest("/api/analyze", payload);
      } catch (error) {
        lastError = error;
        if (attempt >= maxAttempts) break;
        elements.processStatus.innerHTML = `<span class="status-dot"></span> 正在重试（${attempt}/${maxAttempts - 1}）`;
        await delay(attempt === 1 ? 3000 : 8000);
        elements.processStatus.innerHTML = '<span class="status-dot"></span> 正在生成问题';
      }
    }
    throw lastError;
  }

  async function fetchAnswerWithRetry(payload, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await apiRequest("/api/analyze", payload);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) {
          await delay(attempt === 1 ? 5000 : 15000);
        }
      }
    }
    throw lastError;
  }

  async function runAnswerQueue({
    provider,
    indices,
    concurrency,
    questions,
    requestId,
    answerResults,
    progress,
    labels
  }) {
    const failures = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < indices.length) {
        const questionIndex = indices[cursor];
        cursor += 1;
        try {
          const data = await fetchAnswerWithRetry({
            phase: "answer",
            requestId,
            provider,
            questionIndex,
            question: questions[questionIndex]
          });
          answerResults[provider][questionIndex] = data;
        } catch (error) {
          failures.push({
            provider,
            questionIndex,
            question: questions[questionIndex],
            message: error.message || "回答失败"
          });
        }
        progress[provider] = answerResults[provider].filter(Boolean).length;
        const config = labels[provider];
        updateTimelineLabel(
          config.index,
          `询问 ${config.name} · ${progress[provider]}/6`,
          progress[provider] === 6
            ? "6 条真实回答已提取"
            : `已完成 ${progress[provider]} 条真实回答`
        );
        if (progress[provider] === 6) {
          updateTimelineStep(config.index, "complete");
        }
        await delay(1200);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return failures;
  }

  async function runConfirmedQuestionTests(draft, retryState = null) {
    const { brief, questions, requestId } = draft;
    if (!core.canAnalyze(remainingQuota)) {
      showToast("今日免费额度已用完，明天自动恢复");
      return;
    }
    clearAnalysisTimers();
    if (!retryState) analysisJudgments = {};
    const labels = {
      deepseek: { index: 1, name: "DeepSeek Flash" },
      glm: { index: 2, name: "GLM 4.6v" }
    };
    const progress = { deepseek: 0, glm: 0 };
    renderTimeline(
      [
        {
          id: "questions",
          label: "提交 6 个已确认买家问题",
          detail: "问题已锁定"
        },
        {
          id: "deepseek",
          label: "询问 DeepSeek Flash · 0/6",
          detail: "等待真实回答"
        },
        {
          id: "glm",
          label: "询问 GLM 4.6v · 0/6",
          detail: "等待真实回答"
        },
        {
          id: "judge",
          label: "按判定项核对回答 · 0/12",
          detail: "等待回答完成"
        },
        {
          id: "extract",
          label: "提取推荐证据与产品理解",
          detail: "等待回答完成"
        },
        {
          id: "score",
          label: "生成 AI 推荐表现",
          detail: "等待证据归一化"
        }
      ],
      false
    );
    setQuestionReviewLocked(true);
    elements.questionReviewStatus.textContent = "已确认并提交";
    pendingQuestions = [];
    elements.report.hidden = true;
    analysisRunning = true;
    hasRun = false;
    elements.startAnalysis.disabled = true;
    $("span", elements.startAnalysis).textContent = "正在检测…";
    elements.processStatus.innerHTML = '<span class="status-dot"></span> 分析中';
    $("#process").scrollIntoView({ behavior: "smooth", block: "start" });

    try {
      let report;
      if (isApiMode()) {
        updateTimelineStep(0, "complete");
        updateTimelineStep(1, "running");
        updateTimelineStep(2, "running");

        const answerResults = {
          deepseek: retryState?.answerResults?.deepseek || Array(questions.length),
          glm: retryState?.answerResults?.glm || Array(questions.length)
        };
        progress.deepseek = answerResults.deepseek.filter(Boolean).length;
        progress.glm = answerResults.glm.filter(Boolean).length;
        elements.retryFailedAnswers.hidden = true;
        elements.confirmQuestions.hidden = true;

        const retryGroups = retryState
          ? Object.fromEntries(
              ["deepseek", "glm"].map((provider) => [
                provider,
                retryState.failedAnswers
                  .filter((item) => item.provider === provider)
                  .map((item) => item.questionIndex)
              ])
            )
          : Object.fromEntries(
              ["deepseek", "glm"].map((provider) => [
                provider,
                questions.map((_, index) => index)
              ])
            );
        const failures = (
          await Promise.all([
            runAnswerQueue({
              provider: "deepseek",
              indices: retryGroups.deepseek,
              concurrency: 1,
              questions,
              requestId,
              answerResults,
              progress,
              labels
            }),
            runAnswerQueue({
              provider: "glm",
              indices: retryGroups.glm,
              concurrency: 1,
              questions,
              requestId,
              answerResults,
              progress,
              labels
            })
          ])
        ).flat();

        if (failures.length) {
          analysisRetryState = { draft, answerResults, failedAnswers: failures };
          analysisRunning = false;
          hasRun = false;
          awaitingQuestionConfirmation = false;
          elements.processStatus.innerHTML =
            '<span class="status-dot"></span> 部分回答失败 · 未扣次数';
          elements.formError.textContent = `还有 ${failures.length} 条回答失败，请重试失败题目。`;
          elements.retryFailedAnswers.hidden = false;
          const retryLabel = $("span", elements.retryFailedAnswers);
          if (retryLabel) retryLabel.textContent = `重试失败题目（${failures.length}）`;
          updateQuota();
          return;
        }
        analysisRetryState = null;

        // Every answer gets its own itemised verdict. A verdict that fails or
        // times out never blocks the report: that answer is scored by the
        // rule-based fallback and the page says so.
        updateTimelineStep(3, "running");
        const judgeTargets = Object.entries(answerResults).flatMap(([provider, answers]) =>
          answers.map((item, questionIndex) =>
            item ? { provider, questionIndex, answer: item.answer } : null
          )
        ).filter(Boolean);
        const judgments = {};
        let judgedCount = 0;
        let judgeFailures = 0;
        let judgeCursor = 0;
        const runJudgeWorker = async () => {
          while (judgeCursor < judgeTargets.length) {
            const target = judgeTargets[judgeCursor];
            judgeCursor += 1;
            const cacheKey = `${target.provider}:${target.questionIndex}`;
            const cached = analysisJudgments[cacheKey];
            if (cached && cached.answer === target.answer) {
              judgments[cacheKey] = cached.judgment;
              judgedCount += 1;
              updateTimelineLabel(
                3,
                `按判定项核对回答 · ${judgedCount}/${judgeTargets.length}`,
                "复用上次的判定结果"
              );
              continue;
            }
            try {
              const data = await apiRequest("/api/analyze", {
                phase: "judge",
                requestId,
                brief,
                provider: target.provider,
                questionIndex: target.questionIndex,
                question: questions[target.questionIndex],
                answer: target.answer
              });
              if (data.judgment) {
                judgments[`${target.provider}:${target.questionIndex}`] = data.judgment;
                analysisJudgments[cacheKey] = {
                  answer: target.answer,
                  judgment: data.judgment
                };
              } else {
                judgeFailures += 1;
              }
            } catch (error) {
              judgeFailures += 1;
            }
            judgedCount += 1;
            updateTimelineLabel(
              3,
              `按判定项核对回答 · ${judgedCount}/${judgeTargets.length}`,
              judgeFailures
                ? `${judgeFailures} 条改用规则判定`
                : "每条得分都能追溯到回答原文"
            );
          }
        };
        await Promise.all(Array.from({ length: 3 }, () => runJudgeWorker()));
        updateTimelineStep(3, "complete");
        updateTimelineStep(4, "running");
        const reportData = await apiRequest("/api/analyze", {
          phase: "report",
          requestId,
          brief,
          questions,
          judgments,
          responses: Object.entries(answerResults).map(([provider, answers]) => ({
            provider,
            model: answers.find(Boolean)?.model || "",
            answers: answers.map((item) => item.answer)
          }))
        });
        report = reportData.report;
      } else {
        const mockBase = core.buildReport(
          brief.brand,
          brief.competitors.map((item) => item.name)
        );
        const mockReport = {
          ...mockBase,
          questions,
          questionStats: mockBase.questionStats.map((item, index) => ({
            ...item,
            question: questions[index]
          })),
          observations: Object.entries(labels).flatMap(([provider, config]) =>
            questions.map((question, questionIndex) => ({
              model: provider === "deepseek" ? "deepseek-flash" : "glm-4.6v",
              provider,
              question,
              questionIndex,
              answer: `本地预览回答：**${config.name}** 对“${question}”的测试响应。`,
              mentioned: mockBase.questionStats[questionIndex]?.mentioned || false,
              rank: mockBase.questionStats[questionIndex]?.mentioned ? 2 : 0,
              sentiment: mockBase.questionStats[questionIndex]?.sentiment || "neutral"
            }))
          )
        };
        updateTimelineStep(0, "complete");
        updateTimelineStep(1, "running");
        updateTimelineStep(2, "running");
        for (let index = 0; index < 6; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 90));
          progress.deepseek += 1;
          progress.glm += 1;
          updateTimelineLabel(
            1,
            `询问 DeepSeek Flash · ${progress.deepseek}/6`,
            `已完成 ${progress.deepseek} 条模拟回答`
          );
          updateTimelineLabel(
            2,
            `询问 GLM 4.6v · ${progress.glm}/6`,
            `已完成 ${progress.glm} 条模拟回答`
          );
        }
        updateTimelineStep(1, "complete");
        updateTimelineStep(2, "complete");
        updateTimelineStep(3, "complete");
        updateTimelineStep(4, "running");
        await new Promise((resolve) => setTimeout(resolve, 160));
        report = {
          ...mockReport,
          id: requestId,
          completedAt: new Date().toISOString()
        };
      }

      updateTimelineStep(4, "complete");
      updateTimelineStep(5, "running");
      markAllTimelineComplete();
      renderTimeline(report.trace || core.timelineFor(report), true);
      elements.processStatus.innerHTML = '<span class="status-dot"></span> 分析完成';
      renderReport(report);
      attachReportToConversation(report);
      elements.report.hidden = false;
      elements.navReport.hidden = false;
      // hasRun must be set before the review re-renders so the "edit and
      // re-test" entry point appears immediately.
      hasRun = true;
      analysisRunning = false;
      renderQuestionReview(questions, "confirmed");
      remainingQuota = Math.max(0, remainingQuota - 1);
      persistQuota();
      updateQuota();
      refreshIcons();
      if (remainingQuota === 0) {
        showToast("今日免费额度已用完，明天自动恢复");
      }
    } catch (error) {
      clearAnalysisTimers();
      elements.processStatus.innerHTML = '<span class="status-dot"></span> 分析失败 · 未扣次数';
      elements.formError.textContent = error.message || "分析失败，请稍后重试。";
      analysisRunning = false;
      hasRun = false;
      awaitingQuestionConfirmation = true;
      renderQuestionReview(questions, "editing");
      updateQuota();
    }
  }

  function currentFormValues() {
    return core.cleanBrief({
      brand: elements.brandInput.value,
      brandProduct: elements.brandProductInput.value,
      competitors: elements.competitorInputs.map((input, index) => ({
        name: input.value,
        product: elements.competitorProductInputs[index]?.value || ""
      })),
      dimensions: elements.directionCheckboxes
        .filter((checkbox) => checkbox.checked)
        .map((checkbox) => checkbox.value),
      other: elements.otherInput.value
    });
  }

  function validateAnalysis() {
    const values = currentFormValues();
    elements.formError.textContent = "";
    if (!values.brand) {
      elements.formError.textContent = "请先输入品牌名称。";
      elements.brandInput.focus();
      return null;
    }
    if (core.isOffTopic(values.brand)) {
      elements.formError.textContent =
        "我专注于 AI 推荐情报分析，请输入你的产品和竞品。";
      elements.brandInput.focus();
      return null;
    }
    return values;
  }

  // Assistant answers arrive as structured blocks (text / task_list / table /
  // sources / quote) so the UI renders them properly instead of dumping prose.
  // The renderer lives in the shared core so it stays unit-testable.

  function conversationState() {
    return { conversations, activeId: activeConversationId };
  }

  function activeConversation() {
    return core.activeConversationOf(conversationState());
  }

  function persistConversations() {
    try {
      localStorage.setItem(
        STORAGE_KEYS.conversations,
        core.serializeConversations(conversationState())
      );
    } catch {
      // A full quota must not break the chat; the UI keeps working in memory.
    }
  }

  function loadConversations() {
    const parsed = core.parseConversations(
      localStorage.getItem(STORAGE_KEYS.conversations)
    );
    conversations = parsed.conversations;
    activeConversationId = parsed.activeId;
    if (!conversations.length) {
      const created = core.createConversation({});
      conversations = [created];
      activeConversationId = created.id;
      persistConversations();
    }
  }

  function renderConversationList() {
    const list = elements.conversationList;
    if (!list) return;
    list.innerHTML = conversations
      .map((conversation) => {
        const created = new Date(conversation.createdAt);
        const createdLabel = Number.isNaN(created.getTime())
          ? ""
          : `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, "0")}-${String(
              created.getDate()
            ).padStart(2, "0")} ${String(created.getHours()).padStart(2, "0")}:${String(
              created.getMinutes()
            ).padStart(2, "0")}`;
        return `
          <li class="conversation-item${
            conversation.id === activeConversationId ? " is-active" : ""
          }${conversation.pinned ? " is-pinned" : ""}" data-conversation-id="${escapeHtml(
            conversation.id
          )}">
            <button type="button" class="conversation-open" data-conversation-open="${escapeHtml(
              conversation.id
            )}">
              <span class="conversation-title">
                ${
                  conversation.pinned
                    ? `<i class="conversation-pin" data-lucide="pin" aria-hidden="true"></i>`
                    : ""
                }${escapeHtml(conversation.title)}
              </span>
              <span class="conversation-meta">${
                conversation.messages.length
              } 条消息 · ${escapeHtml(createdLabel)}</span>
            </button>
            <button
              type="button"
              class="conversation-more"
              data-conversation-menu="${escapeHtml(conversation.id)}"
              aria-label="更多操作"
              title="更多操作"
            ><i data-lucide="ellipsis"></i></button>
            <div class="conversation-menu" data-conversation-menu-panel="${escapeHtml(
              conversation.id
            )}" hidden>
              <button type="button" data-conversation-pin="${escapeHtml(conversation.id)}">
                <i data-lucide="${conversation.pinned ? "pin-off" : "pin"}"></i>
                <span>${conversation.pinned ? "取消置顶" : "置顶"}</span>
              </button>
              <button type="button" data-conversation-rename="${escapeHtml(conversation.id)}">
                <i data-lucide="pencil"></i><span>重命名</span>
              </button>
              <button type="button" class="is-danger" data-conversation-delete="${escapeHtml(
                conversation.id
              )}">
                <i data-lucide="trash-2"></i><span>删除</span>
              </button>
            </div>
          </li>
        `;
      })
      .join("");
    refreshIcons();
  }

  function renderActiveConversation() {
    elements.chatMessages.replaceChildren();
    const conversation = activeConversation();
    (conversation?.messages || []).forEach((message) =>
      addChatMessage(message.text, message.role === "user", message.blocks)
    );
    if (elements.chatConversationLabel) {
      elements.chatConversationLabel.textContent = core.conversationLabel(
        conversationState()
      );
    }
    renderConversationList();
  }

  function switchConversation(id) {
    if (!conversations.some((item) => item.id === id)) return;
    closeConversationMenus();
    activeConversationId = id;
    persistConversations();
    renderActiveConversation();
    if (!analysisRunning) applyConversationView();
  }

  function beginConversationRename(id) {
    const item = $(`[data-conversation-id="${id}"]`, elements.conversationList);
    const title = $(".conversation-title", item);
    if (!item || !title) return;
    const current = conversations.find((conversation) => conversation.id === id);
    title.outerHTML = `<input
      class="conversation-rename-input"
      data-conversation-rename-input="${escapeHtml(id)}"
      maxlength="40"
      value="${escapeHtml(current?.title || "")}"
      aria-label="对话名称"
    />`;
    const input = $(".conversation-rename-input", item);
    if (input) {
      input.focus();
      input.select();
    }
  }

  function commitConversationRename(input) {
    const id = input.dataset.conversationRenameInput;
    if (!id || input.dataset.committed === "1") return;
    input.dataset.committed = "1";
    conversations = core.renameConversation(conversations, id, input.value);
    persistConversations();
    renderActiveConversation();
  }

  // Two-step delete: the first click asks for confirmation, the second removes.
  function handleConversationDelete(button) {
    const id = button.dataset.conversationDelete;
    if (button.dataset.confirm !== "1") {
      $$("[data-conversation-delete]", elements.conversationList).forEach((item) => {
        item.dataset.confirm = "";
        const label = $("span", item);
        if (label) label.textContent = "删除";
      });
      button.dataset.confirm = "1";
      const label = $("span", button);
      if (label) label.textContent = "确认删除";
      return;
    }
    closeConversationMenus();
    conversations = core.removeConversation(conversations, id);
    if (!conversations.length) {
      const created = core.createConversation({});
      conversations = [created];
      activeConversationId = created.id;
    } else if (activeConversationId === id) {
      activeConversationId = conversations[0].id;
    }
    persistConversations();
    renderActiveConversation();
    if (!analysisRunning) applyConversationView();
    showToast("对话已删除");
  }

  function closeConversationMenus() {
    $$("[data-conversation-menu-panel]", elements.conversationList).forEach((panel) => {
      panel.hidden = true;
    });
    $$("[data-conversation-delete]", elements.conversationList).forEach((item) => {
      item.dataset.confirm = "";
      const label = $("span", item);
      if (label) label.textContent = "删除";
    });
  }

  function toggleConversationMenu(id, trigger) {
    const panel = $(
      `[data-conversation-menu-panel="${id}"]`,
      elements.conversationList
    );
    if (!panel) return;
    const willOpen = panel.hidden;
    closeConversationMenus();
    panel.hidden = !willOpen;
    if (trigger) trigger.setAttribute("aria-expanded", String(willOpen));
  }

  function toggleConversationPin(id) {
    const current = conversations.find((item) => item.id === id);
    if (!current) return;
    conversations = core.pinConversation(conversations, id, !current.pinned);
    conversations = core.pruneConversations(conversations, undefined, activeConversationId);
    persistConversations();
    renderActiveConversation();
    showToast(current.pinned ? "已取消置顶" : "已置顶对话");
  }

  // The report belongs to the conversation that produced it, so switching
  // conversations switches the report on screen too.
  function attachReportToConversation(report) {
    const conversation = activeConversation();
    if (!conversation || !report) return;
    conversations = conversations.map((item) =>
      item.id === conversation.id
        ? { ...item, report, updatedAt: new Date().toISOString() }
        : item
    );
    persistConversations();
    renderConversationList();
  }

  function applyConversationView() {
    const report = activeConversation()?.report || null;
    if (report) {
      activeReport = report;
      hasRun = true;
      renderReport(report);
      elements.report.hidden = false;
      elements.navReport.hidden = false;
      return;
    }
    activeReport = null;
    hasRun = false;
    elements.report.hidden = true;
    elements.navReport.hidden = true;
  }

  function startConversation() {
    const created = core.createConversation({});
    // Keep the new conversation even when every slot is pinned.
    conversations = core.pruneConversations([created, ...conversations], undefined, created.id);
    activeConversationId = created.id;
    persistConversations();
    renderActiveConversation();
    return created;
  }

  // Persists one message into the active conversation, then paints it.
  function pushChatMessage(text, isUser = false, blocks = null) {
    const conversation = activeConversation() || startConversation();
    conversations = conversations.map((item) =>
      item.id === conversation.id
        ? core.appendConversationMessage(item, { role: isUser ? "user" : "assistant", text, blocks })
        : item
    );
    persistConversations();
    addChatMessage(text, isUser, blocks);
    if (elements.chatConversationLabel) {
      elements.chatConversationLabel.textContent = core.conversationLabel(conversationState());
    }
    renderConversationList();
  }

  function conversationContext() {
    return (activeConversation()?.messages || [])
      .slice(-12)
      .map((message) => ({ role: message.role, content: message.text }));
  }

  function addChatMessage(text, isUser = false, blocks = null) {
    const item = document.createElement("div");
    item.className = `chat-message${isUser ? " is-user" : ""}`;
    item.innerHTML = isUser ? "<p></p>" : `<div class="chat-content"></div>`;
    if (isUser) $("p", item).textContent = text;
    else {
      const content = $(".chat-content", item);
      const html = Array.isArray(blocks) && blocks.length ? core.renderAnswerBlocks(blocks) : "";
      content.innerHTML = html || renderMarkdown(text);
    }
    elements.chatMessages.appendChild(item);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  function addTemporaryChatMessage(text) {
    const item = document.createElement("div");
    item.className = "chat-message";
    item.dataset.temporary = "true";
    item.innerHTML = '<div class="chat-content"></div>';
    $(".chat-content", item).textContent = text;
    elements.chatMessages.appendChild(item);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
    return item;
  }

  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function pageContextState() {
    const brief = currentFormValues();
    const reportState = analysisRunning
      ? "running"
      : hasRun
        ? activeReport.isReal
          ? "complete"
          : "mock_complete"
        : "draft";
    const hasReport = ["complete", "mock_complete"].includes(reportState);
    return {
      brief,
      brand: brief.brand,
      brandProduct: brief.brandProduct,
      competitors: brief.competitors.map((item) => item.name),
      competitorProducts: brief.competitors.map((item) => item.product),
      dimensions: brief.dimensions,
      other: brief.other,
      buyerQuestions: pendingQuestions,
      reportState,
      report: hasReport
        ? {
            id: activeReport.id || "",
            isReal: Boolean(activeReport.isReal),
            completedAt: activeReport.completedAt || "",
            brand: activeReport.brand,
            competitors: activeReport.competitors,
            score: activeReport.score,
            mentioned: activeReport.mentioned,
            totalQuestions: activeReport.totalQuestions,
            sentiment: activeReport.sentiment,
            rank: activeReport.rank,
            metrics: activeReport.metrics,
            matrix: activeReport.matrix,
            questions: activeReport.questions,
            questionStats: activeReport.questionStats,
            modelStats: activeReport.modelStats,
            positioning: activeReport.positioning,
            suggestions: (activeReport.suggestions || []).map((item) => ({
              title: item.title,
              analysis: item.analysis || item.detail,
              suggestion: item.suggestion || item.detail,
              evidence: (item.evidence || []).map((evidence) => ({
                model: evidence.model || evidence.provider,
                question: evidence.question,
                quote: evidence.quote
              }))
            })),
            observations: (activeReport.observations || []).map((item) => ({
              model: item.model,
              provider: item.provider,
              question: item.question,
              answer: String(item.answer || "").slice(0, 360),
              mentioned: item.mentioned,
              rank: item.rank,
              sentiment: item.sentiment
            }))
          }
        : null
    };
  }

  function applyAgentActions(actions = []) {
    actions.forEach((action) => {
      if (action.type === "fill_form" || action.type === "prepare_analysis") {
        elements.brandInput.value = action.payload.brand || "";
        elements.brandProductInput.value = action.payload.brandProduct || "";
        elements.competitorInputs.forEach((input, index) => {
          input.value = action.payload.competitors?.[index] || "";
        });
        elements.competitorProductInputs.forEach((input, index) => {
          input.value = action.payload.competitorProducts?.[index] || "";
        });
        elements.otherInput.value = action.payload.other || "";
        $("#workspace").scrollIntoView({ behavior: "smooth" });
        $(".analysis-form").classList.add("is-highlighted");
        if (action.payload.needsProductDetails) addProductDetailPrompt();
      }
      if (action.type === "update_competitors") {
        elements.competitorInputs.forEach((input, index) => {
          input.value = action.payload.competitors?.[index] || "";
        });
      }
      if (action.type === "add_buyer_question") {
        pendingQuestions.push(action.payload.question);
        showToast("已加入下次检测的问题草稿");
      }
    });
  }

  async function requestAgent(text) {
    pushChatMessage(text, true);
    if (!isApiMode()) {
      pushChatMessage("当前预览未连接页面 Agent，请在公开部署版本中使用。");
      return;
    }
    const loading = addTemporaryChatMessage("正在整理页面上下文并选择工具…");
    try {
      const data = await apiRequest("/api/agent", {
        conversationId: activeConversationId,
        messages: conversationContext(),
        pageContext: hasRun ? "report" : "input",
        state: pageContextState()
      });
      loading.remove();
      applyAgentActions(data.actions);
      pushChatMessage(data.reply, false, data.blocks);
    } catch (error) {
      loading.remove();
      pushChatMessage(error.message || "AI 助手暂时不可用，请稍后重试。");
    }
  }

  function addProductDetailPrompt() {
    const item = document.createElement("div");
    item.className = "chat-message";
    item.innerHTML = `
      <p>是否补充产品型号？</p>
      <div class="chat-actions">
        <button type="button" data-product-detail-action="fill">补充型号</button>
        <button type="button" data-product-detail-action="continue">按品牌继续</button>
      </div>
    `;
    elements.chatMessages.appendChild(item);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  function addImageMessage(file) {
    const item = document.createElement("div");
    item.className = "chat-message has-image";
    item.innerHTML = `
      <div class="image-message-grid">
        <div class="image-preview"><img alt="上传的分析素材" /></div>
        <p>图片中的文字可以提取，但我无法判断它属于你的品牌还是竞品。请先选择用途。</p>
      </div>
      <div class="image-role-actions">
        <button type="button" data-image-role="brand">我的品牌素材</button>
        <button type="button" data-image-role="competitor">竞品素材</button>
        <button type="button" data-image-role="reference">仅作参考</button>
      </div>
    `;
    $("img", item).src = URL.createObjectURL(file);
    item.dataset.pendingImage = "true";
    elements.chatMessages.appendChild(item);
    elements.chatMessages.scrollTop = elements.chatMessages.scrollHeight;
  }

  elements.analysisForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = validateAnalysis();
    if (values) prepareAnalysis(values);
  });

  $("#fillExample").addEventListener("click", () => {
    elements.brandInput.value = "小米";
    elements.brandProductInput.value = "小米 14";
    // The example replaces the whole form: anything the user typed into the
    // other competitor slots has to be cleared, not left behind.
    elements.competitorInputs.forEach((input, index) => {
      input.value = index === 0 ? "Apple" : "";
    });
    elements.competitorProductInputs.forEach((input, index) => {
      input.value = index === 0 ? "iPhone 17 Pro" : "";
    });
    elements.directionCheckboxes.forEach((checkbox) => {
      checkbox.checked = checkbox.value === "产品体验";
    });
    elements.otherInput.value = "重点比较日常使用中的产品体验";
    elements.formError.textContent = "";
    showToast("示例已填入，请确认后开始检测");
  });

  elements.confirmQuestions.addEventListener("click", () => {
    const questions = readConfirmedQuestions();
    if (!questions || !analysisDraft || analysisRunning) return;
    const coverage = core.questionCoverage(analysisDraft.brief, questions);
    const brandCoverage = coverage.entities.find((entity) => entity.type === "brand");
    // Every question has to name the user's own product: otherwise that
    // question says nothing about the thing this report is about.
    if (!brandCoverage || brandCoverage.count < coverage.total) {
      const missing = coverage.issues
        .filter((item) => item.problems.includes("missing_brand"))
        .map((item) => `第 ${item.index + 1} 题`);
      elements.questionReviewError.textContent = missing.length
        ? `每题都需要包含你的品牌，请先修改 ${missing.join("、")}。`
        : "每题都需要包含你的品牌。";
      updateQuestionCoverage();
      const first = $('[data-question-issue].is-visible', elements.questionEditorList);
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    analysisDraft.questions = questions;
    awaitingQuestionConfirmation = false;
    renderQuestionReview(questions, "confirmed");
    updateQuota();
    runConfirmedQuestionTests(analysisDraft);
  });

  elements.retryFailedAnswers.addEventListener("click", () => {
    if (!analysisRetryState || analysisRunning) return;
    runConfirmedQuestionTests(
      analysisRetryState.draft,
      analysisRetryState
    );
  });

  elements.regenerateQuestions.addEventListener("click", () => {
    if (!analysisDraft || analysisRunning) return;
    prepareAnalysis(analysisDraft.brief);
  });

  elements.editQuestions.addEventListener("click", () => {
    if (!analysisDraft || analysisRunning) return;
    renderQuestionReview(analysisDraft.questions, "editing");
    elements.questionReviewError.textContent = "";
    elements.confirmQuestions.disabled = false;
    $("#process").scrollIntoView({ behavior: "smooth", block: "start" });
    const first = $('[data-question-index="0"]', elements.questionEditorList);
    if (first) first.focus();
  });

  $("#chatAttach").addEventListener("click", () => elements.chatImageInput.click());

  elements.chatImageInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/") || file.size > 5 * 1024 * 1024) {
      showToast("请上传不超过 5MB 的 PNG 或 JPG 图片");
      return;
    }
    elements.chatPanel.hidden = false;
    fileToDataUrl(file)
      .then((dataUrl) => {
        pendingImage = {
          dataUrl,
          base64: dataUrl.split(",")[1],
          mimeType: file.type,
          name: file.name
        };
        addImageMessage(file);
      })
      .catch(() => showToast("图片读取失败，请重试"));
  });

  elements.chatMessages.addEventListener("click", (event) => {
    const confirmAction = event.target.closest("[data-confirm-action]");
    if (confirmAction) {
      elements.chatPanel.hidden = true;
      $("#workspace").scrollIntoView({ behavior: "smooth" });
      $(".analysis-form").classList.add("is-highlighted");
      showToast("已定位到检测表单，确认后即可开始检测");
      return;
    }
    const detailAction = event.target.closest("[data-product-detail-action]");
    if (detailAction) {
      if (detailAction.dataset.productDetailAction === "fill") {
        elements.brandProductInput.focus();
        $("#workspace").scrollIntoView({ behavior: "smooth" });
      } else if (detailAction.dataset.productDetailAction === "continue") {
        prepareAnalysis(currentFormValues());
      }
      return;
    }
    const button = event.target.closest("[data-image-role]");
    if (!button) return;
    const role = button.dataset.imageRole;
    const item = button.closest(".chat-message");
    $(".image-role-actions", item)?.remove();
    const extractImage = async () => {
      const loading = addTemporaryChatMessage("正在读取图片中的可见信息…");
      try {
        if (!isApiMode() || !pendingImage) {
          loading.remove();
          addChatMessage("当前预览未连接图片识别服务。");
          return;
        }
        const data = await apiRequest("/api/extract-image", {
          imageData: pendingImage.base64,
          mimeType: pendingImage.mimeType,
          role
        });
        const extracted = data.extracted;
        loading.remove();
        if (role === "brand") {
          if (extracted.brand) {
            elements.brandInput.value = extracted.brand;
            elements.brandInput.closest(".field").classList.add("is-highlighted");
          }
          addChatMessage(
            extracted.brand
              ? `已按你的标注记录为品牌素材，并提取“${extracted.brand}”填入品牌字段。`
              : "已记录为品牌素材，但没有识别到可验证的品牌名称。"
          );
        } else if (role === "competitor") {
          const names = extracted.competitors || [];
          elements.competitorInputs.forEach((input, index) => {
            if (!input.value.trim() || index < names.length) input.value = names[index] || "";
          });
          addChatMessage(
            names.length
              ? `已按你的标注记录为竞品素材，提取到：${names.join("、")}。`
              : "已记录为竞品素材，但没有识别到可验证的竞品名称。"
          );
        } else {
          addChatMessage(extracted.summary ? `已仅作为参考：${extracted.summary}` : "已仅保留为分析参考。");
        }
      } catch (error) {
        loading.remove();
        addChatMessage(error.message || "图片识别暂时不可用。");
      } finally {
        pendingImage = null;
        refreshIcons();
      }
    };
    extractImage();
  });

  elements.questionTable.addEventListener("click", (event) => {
    const button = event.target.closest("[data-score-index]");
    if (!button) return;
    const breakdown = $(`[data-score-breakdown="${button.dataset.scoreIndex}"]`);
    if (!breakdown) return;
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", expanded ? "false" : "true");
    button.classList.toggle("is-open", !expanded);
    breakdown.hidden = expanded;
  });

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => {
        item.classList.toggle("is-active", item === tab);
        item.setAttribute("aria-selected", item === tab ? "true" : "false");
      });
      $$(".report-panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.dataset.panel === tab.dataset.tab);
      });
    });
  });

  $("#chatToggle").addEventListener("click", () => {
    elements.chatPanel.hidden = !elements.chatPanel.hidden;
    if (!elements.chatPanel.hidden) $("#chatInput").focus();
  });

  elements.toggleConversations.addEventListener("click", () => {
    elements.chatConversations.hidden = !elements.chatConversations.hidden;
    if (!elements.chatConversations.hidden) {
      renderConversationList();
      elements.chatConversations.scrollTop = 0;
    }
  });

  // A click anywhere else closes the row menu.
  document.addEventListener("click", (event) => {
    if (!elements.conversationList.contains(event.target)) closeConversationMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeConversationMenus();
  });

  elements.newConversation.addEventListener("click", () => {
    startConversation();
    showToast("已新建对话");
  });

  elements.conversationList.addEventListener("click", (event) => {
    const menu = event.target.closest("[data-conversation-menu]");
    if (menu) {
      toggleConversationMenu(menu.dataset.conversationMenu, menu);
      return;
    }
    const pin = event.target.closest("[data-conversation-pin]");
    if (pin) {
      toggleConversationPin(pin.dataset.conversationPin);
      return;
    }
    const open = event.target.closest("[data-conversation-open]");
    if (open) {
      switchConversation(open.dataset.conversationOpen);
      return;
    }
    const rename = event.target.closest("[data-conversation-rename]");
    if (rename) {
      closeConversationMenus();
      beginConversationRename(rename.dataset.conversationRename);
      return;
    }
    const remove = event.target.closest("[data-conversation-delete]");
    if (remove) {
      handleConversationDelete(remove);
    }
  });

  elements.conversationList.addEventListener("keydown", (event) => {
    if (!event.target.classList.contains("conversation-rename-input")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitConversationRename(event.target);
    }
    if (event.key === "Escape") {
      renderConversationList();
    }
  });

  elements.conversationList.addEventListener("focusout", (event) => {
    if (!event.target.classList.contains("conversation-rename-input")) return;
    commitConversationRename(event.target);
  });

  $("#closeChat").addEventListener("click", () => {
    elements.chatPanel.hidden = true;
  });

  $("#chatForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("#chatInput").value.trim();
    if (!text) return;
    $("#chatInput").value = "";
    // requestAgent persists and paints the user message; painting it here too
    // showed the same bubble twice.
    requestAgent(text);
  });

  loadQuota();
  loadConversations();
  renderActiveConversation();
  renderQuestionReview([], "loading");
  // 评分标准与计算方式现在放在页面底部的「说明」里，所以除了每次出报告，
  // 页面刚打开时也要渲染一次。
  renderScoringStandard(null);
  updateQuota();
  refreshIcons();

  // QA hook: the local mock flow never produces judge rationales, so the visual
  // smoke test renders a report that carries them through this entry point.
  window.answerLensQA = { renderReport };
})();
