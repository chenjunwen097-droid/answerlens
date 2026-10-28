(function () {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const anime = !reduceMotion && window.anime ? window.anime : null;
  const icons = () => window.lucide?.createIcons();
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  // ── Mock data ──────────────────────────────────────────────────────────
  function buildReport({ id, brand, product, competitors, score, date, version = 1, runs = 1 }) {
    const [c1, c2] = competitors;
    const name = product || brand;
    const questions = [
      { q: `${name} 最适合哪类用户？为什么？`, score: score + 4 },
      { q: `${name} 和 ${c1} 相比，核心优势是什么？`, score: score - 3 },
      { q: `预算有限时，应该选 ${name} 还是 ${c1}？`, score: score - 8 },
      { q: `${name} 有哪些被反复提到的短板？`, score: score + 1 },
      { q: `长时间使用时，${name} 和 ${c2} 哪个更省心？`, score: score - 5 },
      { q: `为什么用户会推荐 ${name}？`, score: score + 6 }
    ].map((item, index) => ({
      ...item,
      score: Math.max(24, Math.min(96, item.score)),
      deepseek: `${name} 在${index % 2 === 0 ? "日常场景" : "对比场景"}里表现稳定，${index === 2 ? `预算敏感时 ${c1} 的入门价更低，但 ${name} 的长期体验更完整` : `优势集中在${["屏幕与手感", "生态协同", "续航稳定性", "售后覆盖"][index % 4]}`}。`,
      glm: `${c1} 在${index % 2 === 0 ? "品牌认知" : "参数对比"}上更常被提及；如果用户更看重${["护眼与亮度", "多设备协同", "长期耐用", "价格透明"][index % 4]}，${name} 是更稳的选择。`
    }));
    return {
      id,
      brand,
      product: product || "",
      competitors,
      score,
      date,
      version,
      runs,
      headline:
        score >= 70
          ? "AI 已经把你列进推荐清单，但理由还不够稳定"
          : "AI 能理解产品，但推荐顺位仍然靠后",
      summary: `${name} 的 AI 推荐表现平均分为 ${score}/100，共分析 6 个决策问题和 12 条真实回答。`,
      metrics: { recommendRate: Math.round(score * 0.92), firstChoiceRate: Math.round(score * 0.46) },
      bars: [
        { name: brand, value: score, rank: 1 },
        { name: c1, value: Math.max(0, score - 8), rank: 2 },
        { name: c2, value: Math.max(0, score - 21), rank: 3 }
      ],
      positioning: [
        { label: "一句话定位", text: `AI 把 ${name} 理解为「${["均衡的日常选择", "参数扎实的稳妥款", "体验完整但需要解释"][id % 3]}」，但缺少一句可复述的定位。` },
        { label: "模型共识", text: `${["屏幕体验", "口感一致性", "产品稳定性"][id % 3]}被两个模型多次提到，是当前最清晰的共识。` },
        { label: "与竞品的关键差异", text: `面对 ${c1} 时，${name} 的优势更多来自长期体验，而不是单点参数。` }
      ],
      actions: [
        { title: `把「${["均衡", "稳妥", "完整"][id % 3]}」改写成可复述的一句话`, why: "两个模型都在描述优势，但没有形成同一句定位。" },
        { title: `补齐 ${c1} 的真实对比页`, why: "用户在预算场景会直接比较，缺少对比内容会丢推荐顺位。" },
        { title: "强化第三方口碑与使用案例", why: "证据完整的回答更容易进入首选清单。" }
      ],
      questions
    };
  }

  const seedReports = [
    buildReport({ id: 0, brand: "小米", product: "小米 14", competitors: ["iPhone 17 Pro", "华为 Mate 70"], score: 72, date: "2026-10-28" }),
    buildReport({ id: 1, brand: "瑞幸", product: "生椰拿铁", competitors: ["库迪生椰拿铁", "Manner"], score: 64, date: "2026-10-27" }),
    buildReport({ id: 2, brand: "喜茶", product: "清爽果茶", competitors: ["林里", "奈雪"], score: 58, date: "2026-10-24" }),
    buildReport({ id: 3, brand: "李宁", product: "跑鞋", competitors: ["安踏", "Nike"], score: 69, date: "2026-10-21" }),
    buildReport({ id: 4, brand: "比亚迪", product: "宋 PLUS", competitors: ["特斯拉 Model Y", "理想 L6"], score: 61, date: "2026-10-18" }),
    buildReport({ id: 5, brand: "美的", product: "空调", competitors: ["格力", "海尔"], score: 75, date: "2026-10-15" })
  ];

  const knownBriefs = [
    { brand: "小米", product: "小米 14", competitors: ["iPhone 17 Pro", "华为 Mate 70"], score: 72 },
    { brand: "瑞幸", product: "生椰拿铁", competitors: ["库迪生椰拿铁", "Manner"], score: 64 },
    { brand: "喜茶", product: "清爽果茶", competitors: ["林里", "奈雪"], score: 58 },
    { brand: "李宁", product: "跑鞋", competitors: ["安踏", "Nike"], score: 69 },
    { brand: "比亚迪", product: "宋 PLUS", competitors: ["特斯拉 Model Y", "理想 L6"], score: 61 }
  ];

  const STEPS = [
    { label: "理解需求", detail: "提取品牌、型号、竞品与检测方向" },
    { label: "联网调研", detail: "DeepSeek Search · 核对型号与背景" },
    { label: "设计问题", detail: "生成 6 个买家问题并校验覆盖" },
    { label: "模型作答", detail: "DeepSeek Flash × 6 · GLM 4.6v × 6" },
    { label: "逐条判定", detail: "五个维度 · 引用原句" },
    { label: "汇总报告", detail: "定位、竞品差距与行动建议" }
  ];

  const state = {
    view: "chat",
    scope: "conversation",
    activeReportId: null,
    reports: seedReports.slice(),
    filter: "all",
    running: false,
    pendingBrief: null,
    messages: [],
    reportThreads: {},
    paletteIndex: 0
  };

  // ── Helpers ────────────────────────────────────────────────────────────
  const escapeHtml = (value) =>
    String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

  function toast(message) {
    const el = $("#toast");
    el.textContent = message;
    el.classList.add("is-visible");
    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.classList.remove("is-visible"), 2200);
  }

  function activeReport() {
    return state.reports.find((item) => item.id === state.activeReportId) || null;
  }

  // ── Views ──────────────────────────────────────────────────────────────
  function paint() {
    $("#chatView").hidden = state.view !== "chat";
    $("#libraryView").hidden = state.view !== "library";
    $("#reportView").hidden = state.view !== "report";
    $$(".rail-item").forEach((item) => {
      item.classList.toggle("is-active", item.dataset.view === state.view);
    });
    const scope = activeReport();
    $("#scopeLabel").textContent =
      state.scope === "report" && scope ? `报告 · ${scope.product || scope.brand}` : "新对话";
    $("#input").placeholder =
      state.scope === "report" && scope
        ? `问这份报告：${scope.product || scope.brand} 的任何问题…`
        : "描述你的产品和竞品，或直接问一个关于报告的问题…";
    const crumb = $("#crumbs");
    if (state.view === "library") {
      crumb.innerHTML = "<span>工作区</span><i data-lucide=\"chevron-right\"></i><strong>报告库</strong>";
    } else if (state.view === "report" && scope) {
      crumb.innerHTML = `<span>报告库</span><i data-lucide="chevron-right"></i><strong>${escapeHtml(
        scope.product || scope.brand
      )}</strong>`;
    } else {
      crumb.innerHTML = "<span>会话</span><i data-lucide=\"chevron-right\"></i><strong>新对话</strong>";
    }
    icons();
  }

  function setView(view, paintFn) {
    const apply = () => {
      state.view = view;
      if (paintFn) paintFn();
      paint();
    };
    if (document.startViewTransition && !reduceMotion) document.startViewTransition(apply);
    else apply();
  }

  // ── Chat ───────────────────────────────────────────────────────────────
  function renderThread() {
    const thread = $("#thread");
    const empty = $("#emptyState");
    const hasMessages = state.messages.length > 0;
    thread.hidden = !hasMessages;
    empty.hidden = hasMessages;
    thread.innerHTML = state.messages
      .map((message) => {
        if (message.typing) {
          return `<div class="msg" data-typing><div class="msg-body"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
        }
        return `
          <div class="msg ${message.role === "user" ? "is-user" : ""}">
            <div class="msg-body">${escapeHtml(message.text)}</div>
            ${
              message.card
                ? `<div class="msg-card">
                     <div class="msg-card-head"><i data-lucide="${message.card.icon || "sparkles"}"></i>${escapeHtml(
                       message.card.title
                     )}</div>
                     ${(message.card.lines || []).map((line) => `<p>${escapeHtml(line)}</p>`).join("")}
                     ${
                       message.card.action
                         ? `<div class="msg-card-actions"><button class="primary-btn" data-card-action="${message.card.action.key}">${escapeHtml(
                             message.card.action.label
                           )}</button></div>`
                         : ""
                     }
                   </div>`
                : ""
            }
            <span class="msg-time">${message.time || "刚刚"}</span>
          </div>`;
      })
      .join("");
    const scroll = $("#chatScroll");
    scroll.scrollTop = scroll.scrollHeight;
    icons();
  }

  function addMessage(role, text, card) {
    state.messages.push({ role, text, card, time: "刚刚" });
    renderThread();
    const last = $("#thread").lastElementChild;
    if (last && anime) {
      anime.animate(last, { opacity: [0, 1], y: [10, 0], duration: 280, ease: "outCubic" });
    }
  }

  function showTyping() {
    state.messages.push({ role: "agent", typing: true });
    renderThread();
  }

  function hideTyping() {
    state.messages = state.messages.filter((message) => !message.typing);
    renderThread();
  }

  function parseBrief(text) {
    return (
      knownBriefs.find((item) => text.includes(item.brand)) || {
        brand: "你的品牌",
        product: "",
        competitors: ["竞品 A", "竞品 B"],
        score: 66
      }
    );
  }

  function submit(text) {
    const value = String(text || "").trim();
    if (!value || state.running) return;
    if (state.view !== "chat" && (state.scope !== "report" || state.view === "library")) {
      setView("chat");
    }
    addMessage("user", value);
    resetComposer();

    if (state.scope === "report" && activeReport()) {
      const report = activeReport();
      const thread = reportThread(report.id);
      thread.push({ role: "user", text: value });
      renderArtifactChat(report, true);
      setTimeout(() => {
        const top = [...report.questions].sort((a, b) => b.score - a.score)[0];
        thread.push(
          {
            role: "agent",
            text:
          `这份报告里，${report.brand} 的第 ${
            report.questions.indexOf(top) + 1
          } 题表现最好（${top.score} 分）。原因是两个模型都主动提到了它在「${
            top.q.includes("优势") ? "核心优势" : "日常体验"
          }」上的具体表现。\n\n需要我把这道题的原始回答调出来对照吗？`
          }
        );
        renderArtifactChat(report);
      }, 620);
      return;
    }

    const brief = parseBrief(value);
    state.pendingBrief = brief;
    showTyping();
    setTimeout(() => {
      hideTyping();
      addMessage(
        "agent",
        `我先按这个方案准备：${brief.product || brief.brand} 对比 ${brief.competitors.join("、")}。\n\n开始前会先联网核对型号与背景，再生成 6 个买家问题——问题可以编辑，确认后才会真正开始模型测试。`,
        {
          title: "准备开始检测",
          icon: "list-checks",
          lines: [
            `品牌：${brief.brand}${brief.product ? ` · ${brief.product}` : ""}`,
            `竞品：${brief.competitors.join("、")}`,
            "预计耗时 3–5 分钟 · 会消耗 1 次免费额度"
          ],
          action: { key: "start-analysis", label: "开始检测" }
        }
      );
    }, 700);
  }

  // ── Composer ───────────────────────────────────────────────────────────
  function resetComposer() {
    const input = $("#input");
    input.value = "";
    input.style.height = "auto";
    $("#sendBtn").disabled = true;
  }

  function resizeInput() {
    const input = $("#input");
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    $("#sendBtn").disabled = !input.value.trim() || state.running;
  }

  function renderScopeMenu() {
    const menu = $("#scopeMenu");
    const options = [
      { id: "conversation", label: "新对话", hint: "全局助手", icon: "message-circle" },
      ...state.reports.slice(0, 5).map((report) => ({
        id: `report:${report.id}`,
        label: `报告 · ${report.product || report.brand}`,
        hint: `v${report.version}`,
        icon: "file-text"
      }))
    ];
    menu.innerHTML = options
      .map(
        (option) => `
        <button type="button" role="menuitem" data-scope="${option.id}" class="${
          (option.id === "conversation" && state.scope === "conversation") ||
          (option.id === `report:${state.activeReportId}` && state.scope === "report")
            ? "is-active"
            : ""
        }">
          <i data-lucide="${option.icon}"></i>
          <span>${escapeHtml(option.label)}</span>
          <small>${escapeHtml(option.hint)}</small>
        </button>`
      )
      .join("");
    icons();
  }

  // ── Analysis ───────────────────────────────────────────────────────────
  function openArtifact(title, html) {
    $("#artifact").hidden = false;
    $("#app").classList.add("has-artifact");
    $("#artifactTitle").textContent = title;
    $("#artifactBody").innerHTML = html;
    icons();
  }

  function closeArtifact() {
    $("#artifact").hidden = true;
    $("#app").classList.remove("has-artifact");
  }

  function renderSteps(index) {
    return `
      <div class="step-list">
        ${STEPS.map(
          (step, i) => `
          <div class="step ${i < index ? "is-done" : i === index ? "is-running" : ""}">
            <span class="step-dot">${i < index ? "✓" : i + 1}</span>
            <div><strong>${step.label}</strong><p>${step.detail}</p></div>
          </div>`
        ).join("")}
      </div>`;
  }

  function startAnalysis(brief) {
    if (state.running) return;
    state.running = true;
    $("#sendBtn").disabled = true;
    openArtifact("分析进度", renderSteps(0));
    state.messages.push({
      role: "agent",
      text: `已开始检测：${brief.product || brief.brand} 对比 ${brief.competitors.join("、")}。进度会实时显示在右侧。`,
      time: "刚刚"
    });
    renderThread();

    let index = 0;
    const tick = () => {
      index += 1;
      if (index < STEPS.length) {
        $("#artifactBody").innerHTML = renderSteps(index);
        return;
      }
      finishAnalysis(brief);
    };
    const timer = setInterval(() => {
      tick();
      if (!state.running) clearInterval(timer);
    }, 780);
  }

  function finishAnalysis(brief) {
    state.running = false;
    const sameProduct = state.reports.filter(
      (item) => item.brand === brief.brand && item.product === brief.product
    );
    const report = buildReport({
      id: state.reports.length,
      brand: brief.brand,
      product: brief.product,
      competitors: brief.competitors,
      score: brief.score,
      date: new Date().toISOString().slice(0, 10),
      version: sameProduct.length ? Math.max(...sameProduct.map((item) => item.version)) + 1 : 1
    });
    state.reports.unshift(report);
    state.activeReportId = report.id;
    state.scope = "report";
    $("#artifactBody").innerHTML = `
      <div class="artifact-report">
        <div class="artifact-score">
          <strong>${report.score}</strong><span> / 100</span>
          <p>${escapeHtml(report.summary)}</p>
        </div>
        <p class="artifact-kicker">报告已生成</p>
        <div class="artifact-list">
          <button type="button" data-report-open="${report.id}">查看完整报告 <span>6 题 · 12 答</span></button>
          <button type="button" data-report-detail="${report.id}">提问明细 <span>逐条判定</span></button>
        </div>
      </div>`;
    $("#artifactTitle").textContent = "报告摘要";
    icons();
    paint();
    addMessage(
      "agent",
      `报告已经生成：${report.brand} 的 AI 推荐表现是 ${report.score}/100。右侧可以先看摘要，也可以直接在这份报告里继续追问。`,
      {
        title: "检测完成",
        icon: "circle-check-big",
        lines: report.actions.map((action) => action.title),
        action: { key: "view-report", label: "查看完整报告" }
      }
    );
    renderMiniReports();
    renderLibrary();
    updateReportCount();
    toast("报告已加入报告库");
  }

  // ── Report ─────────────────────────────────────────────────────────────
  function openReport(id) {
    const report = state.reports.find((item) => item.id === Number(id));
    if (!report) return;
    state.activeReportId = report.id;
    state.scope = "report";
    setView("report", () => renderReport(report));
    openArtifact("报告信息", renderReportAside(report));
  }

  function renderReportAside(report) {
    return `
      <div class="artifact-report">
        <button class="ghost-btn" type="button" data-report-chat="${report.id}" style="width:100%;justify-content:center">
          <i data-lucide="message-circle"></i> 报告对话 <span style="margin-left:auto;font-size:10px;color:var(--faint)">${
            reportThread(report.id).length
          } 条</span>
        </button>
        <p class="artifact-kicker">目录</p>
        <div class="artifact-list">
          <button type="button" data-report-tab="overview">总览 <span>分数与建议</span></button>
          <button type="button" data-report-tab="detail">提问明细 <span>${report.questions.length} 题</span></button>
        </div>
        <p class="artifact-kicker">元数据</p>
        <div class="artifact-list">
          <button type="button" disabled>模型 <span>DeepSeek Flash · GLM 4.6v</span></button>
          <button type="button" disabled>版本 <span>v${report.version}</span></button>
          <button type="button" disabled>检测时间 <span>${report.date}</span></button>
        </div>
      </div>`;
  }

  function reportThread(id) {
    if (!state.reportThreads[id]) state.reportThreads[id] = [];
    return state.reportThreads[id];
  }

  function renderArtifactChat(report, pending) {
    const thread = reportThread(report.id);
    openArtifact(
      "报告对话",
      `<div class="artifact-chat">
        <div class="artifact-chat-head">
          <span>${escapeHtml(report.product || report.brand)} · v${report.version}</span>
          <button class="link-btn" type="button" data-report-tab="detail">查看提问明细</button>
        </div>
        <div class="artifact-chat-list">
          ${
            thread.length
              ? thread
                  .map(
                    (message) => `
                    <div class="artifact-msg ${message.role === "user" ? "is-user" : ""}">
                      <span>${message.role === "user" ? "你" : "AnswerLens"}</span>
                      <p>${escapeHtml(message.text)}</p>
                    </div>`
                  )
                  .join("")
              : `<div class="artifact-empty">在这份报告里直接提问，例如「第 2 题为什么得分低？」</div>`
          }
          ${pending ? `<div class="artifact-msg"><span>AnswerLens</span><p>正在查看这份报告的证据…</p></div>` : ""}
        </div>
      </div>`
    );
  }

  function renderReport(report) {
    $("#reportTitle").textContent = `${report.product || report.brand} 的 AI 推荐情报`;
    $("#reportMeta").textContent = `${report.date} · 2 个模型 · 6 个问题 · v${report.version}`;
    $("#reportHeadline").textContent = report.headline;
    $("#reportSummary").textContent = report.summary;
    $("#reportScore").textContent = "0";
    $("#reportScoreRing").style.background = "conic-gradient(var(--orange) 0 0%, #e9e4db 0% 100%)";
    const start = performance.now();
    const step = (now) => {
      const progress = reduceMotion ? 1 : Math.min(1, (now - start) / 900);
      const value = Math.round(report.score * easeOutCubic(progress));
      $("#reportScore").textContent = String(value);
      $("#reportScoreRing").style.background = `conic-gradient(var(--orange) 0 ${value}%, #e9e4db ${value}% 100%)`;
      if (progress < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    $("#reportBars").innerHTML = report.bars
      .map(
        (bar) => `
        <div class="bar-row">
          <b>${bar.rank ? `#${bar.rank} ` : ""}${escapeHtml(bar.name)}</b>
          <div class="bar-track"><div class="bar-fill" data-target="${bar.value}%"></div></div>
          <strong>${bar.value}</strong>
        </div>`
      )
      .join("");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        $$("#reportBars .bar-fill").forEach((fill, index) => {
          fill.style.transitionDelay = `${index * 70}ms`;
          fill.style.setProperty("--value", fill.dataset.target);
        });
      })
    );

    $("#reportPositioning").innerHTML = report.positioning
      .map((item) => `<div><span>${escapeHtml(item.label)}</span><p>${escapeHtml(item.text)}</p></div>`)
      .join("");
    $("#reportActions").innerHTML = report.actions
      .map(
        (action, index) => `
        <li><i>0${index + 1}</i><div><strong>${escapeHtml(action.title)}</strong><span>${escapeHtml(
          action.why
        )}</span></div></li>`
      )
      .join("");

    $("#reportDetail").innerHTML = report.questions
      .map(
        (question, index) => `
        <details class="detail-item" ${index === 0 ? "open" : ""}>
          <summary>
            <span class="detail-index">0${index + 1}</span>
            <strong>${escapeHtml(question.q)}</strong>
            <em>${question.score}</em>
          </summary>
          <div class="detail-body">
            <div class="answer"><b>DeepSeek Flash</b>${escapeHtml(question.deepseek)}</div>
            <div class="answer"><b>GLM 4.6v</b>${escapeHtml(question.glm)}</div>
          </div>
        </details>`
      )
      .join("");

    if (anime) {
      anime.animate(".score-card, .report-panel .block, .detail-list", {
        opacity: [0, 1],
        y: [14, 0],
        duration: 420,
        delay: anime.stagger(55),
        ease: "outCubic"
      });
    }
    switchReportTab($(".report-tabs .is-active")?.dataset.tab || "overview");
  }

  function switchReportTab(tab) {
    $$("#reportTabs button").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.tab === tab);
    });
    $$("#reportView .report-panel").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
  }

  // ── Library ────────────────────────────────────────────────────────────
  function renderLibrary() {
    const filtered = state.reports.filter((report) => {
      if (state.filter === "high") return report.score >= 70;
      if (state.filter === "low") return report.score < 70;
      return true;
    });
    $("#reportGrid").innerHTML = filtered
      .map(
        (report) => `
        <button class="report-card" type="button" data-report-open="${report.id}">
          <div class="report-card-top">
            <div>
              <h3>${escapeHtml(report.product || report.brand)}</h3>
              <p>${escapeHtml(report.competitors.join(" · "))}</p>
            </div>
            <div class="report-score">${report.score}<span>/100</span></div>
          </div>
          <div class="report-card-foot">
            <span class="tag ${report.score >= 70 ? "is-ok" : ""}">v${report.version}</span>
            <span class="tag">${report.date}</span>
          </div>
        </button>`
      )
      .join("");
  }

  function renderMiniReports() {
    $("#miniReports").innerHTML = state.reports
      .slice(0, 3)
      .map(
        (report) => `
        <button class="mini-report" type="button" data-report-open="${report.id}">
          <span>${escapeHtml(report.product || report.brand)}</span>
          <b>${report.score}</b>
          <span>${report.date}</span>
        </button>`
      )
      .join("");
  }

  function updateReportCount() {
    $("#reportCount").textContent = String(state.reports.length + 6);
  }

  // ── Palette ────────────────────────────────────────────────────────────
  const paletteActions = [
    { label: "新建对话", hint: "会话", run: () => { newConversation(); closePalette(); } },
    { label: "打开报告库", hint: "导航", run: () => { openLibrary(); closePalette(); } },
    { label: "分享当前报告", hint: "操作", run: () => { toast("已复制分享链接（原型）"); closePalette(); } }
  ];

  function renderPalette(query = "") {
    const q = query.trim().toLowerCase();
    const reportActions = state.reports.slice(0, 5).map((report) => ({
      label: `打开报告 · ${report.product || report.brand}`,
      hint: `v${report.version}`,
      run: () => { openReport(report.id); closePalette(); }
    }));
    const items = [...paletteActions, ...reportActions].filter((item) =>
      item.label.toLowerCase().includes(q)
    );
    $("#paletteList").innerHTML = items
      .map(
        (item, index) => `
        <button type="button" data-palette="${index}" class="${index === 0 ? "is-hover" : ""}">
          <i data-lucide="arrow-up-right"></i>
          <span>${escapeHtml(item.label)}</span>
          <small>${escapeHtml(item.hint)}</small>
        </button>`
      )
      .join("");
    $("#paletteList").__items = items;
    icons();
  }

  function openPalette() {
    $("#palette").hidden = false;
    $("#paletteInput").value = "";
    renderPalette();
    $("#paletteInput").focus();
  }

  function closePalette() {
    $("#palette").hidden = true;
  }

  function newConversation() {
    state.scope = "conversation";
    state.messages = [];
    state.pendingBrief = null;
    resetComposer();
    renderThread();
    setView("chat");
    closeArtifact();
    $("#input").focus();
  }

  function openLibrary() {
    state.scope = "conversation";
    state.activeReportId = null;
    closeArtifact();
    setView("library", renderLibrary);
  }

  // ── Events ─────────────────────────────────────────────────────────────
  function bind() {
    $("#sendBtn").disabled = true;

    $("#input").addEventListener("input", resizeInput);
    $("#input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        $("#composer").requestSubmit();
      }
    });
    $("#composer").addEventListener("submit", (event) => {
      event.preventDefault();
      submit($("#input").value);
    });

    $("#suggestions").addEventListener("click", (event) => {
      const button = event.target.closest("[data-prompt]");
      if (!button) return;
      $("#input").value = button.dataset.prompt;
      resizeInput();
      $("#input").focus();
    });

    $("#newChat").addEventListener("click", newConversation);
    $("#libraryNewChat").addEventListener("click", () => {
      newConversation();
      setView("chat");
    });
    $("#openLibraryFromEmpty").addEventListener("click", openLibrary);

    $$(".rail-item").forEach((item) => {
      item.addEventListener("click", () => {
        if (item.dataset.view === "library") openLibrary();
        else if (item.dataset.view === "chat") setView("chat");
        else toast("品牌与竞品（原型未展开）");
      });
    });

    $("#collapseRail").addEventListener("click", () => $("#app").classList.toggle("rail-collapsed"));

    $("#scopeChip").addEventListener("click", () => {
      const menu = $("#scopeMenu");
      const open = menu.hidden;
      renderScopeMenu();
      menu.hidden = !open;
      $("#scopeChip").setAttribute("aria-expanded", String(open));
    });
    $("#scopeMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-scope]");
      if (!button) return;
      $("#scopeMenu").hidden = true;
      $("#scopeChip").setAttribute("aria-expanded", "false");
      if (button.dataset.scope === "conversation") {
        newConversation();
      } else {
        openReport(button.dataset.scope.split(":")[1]);
      }
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#composer")) {
        $("#scopeMenu").hidden = true;
        $("#scopeChip").setAttribute("aria-expanded", "false");
      }
    });

    document.addEventListener("click", (event) => {
      const open = event.target.closest("[data-report-open]");
      if (open) {
        openReport(open.dataset.reportOpen);
        return;
      }
      const detail = event.target.closest("[data-report-detail]");
      if (detail) {
        openReport(detail.dataset.reportDetail);
        switchReportTab("detail");
        return;
      }
      const tab = event.target.closest("[data-report-tab]");
      if (tab) {
        if (state.view !== "report") openReport(state.activeReportId);
        switchReportTab(tab.dataset.reportTab);
        return;
      }
      const reportChat = event.target.closest("[data-report-chat]");
      if (reportChat) {
        const report = state.reports.find((item) => item.id === Number(reportChat.dataset.reportChat));
        if (report) renderArtifactChat(report);
        return;
      }
      const action = event.target.closest("[data-card-action]");
      if (action) {
        if (action.dataset.cardAction === "start-analysis") {
          startAnalysis(state.pendingBrief || { brand: "你的品牌", product: "", competitors: ["竞品 A", "竞品 B"], score: 66 });
        }
        if (action.dataset.cardAction === "view-report") openReport(state.activeReportId);
        if (action.dataset.cardAction === "open-detail") {
          openReport(state.activeReportId);
          switchReportTab("detail");
        }
      }
    });

    $("#closeArtifact").addEventListener("click", closeArtifact);
    $("#reportBack").addEventListener("click", openLibrary);
    $("#reportRerun").addEventListener("click", () => {
      const report = activeReport();
      if (!report) return;
      startAnalysis({ brand: report.brand, product: report.product, competitors: report.competitors, score: report.score });
    });
    $("#shareBtn").addEventListener("click", () => toast("已复制分享链接（原型）"));
    $("#reportTabs").addEventListener("click", (event) => {
      const button = event.target.closest("[data-tab]");
      if (button) switchReportTab(button.dataset.tab);
    });
    $("#libraryFilter").addEventListener("click", (event) => {
      const button = event.target.closest("[data-filter]");
      if (!button) return;
      state.filter = button.dataset.filter;
      $$("#libraryFilter button").forEach((item) => item.classList.toggle("is-active", item === button));
      renderLibrary();
    });

    $("#openPalette").addEventListener("click", openPalette);
    $("#palette").addEventListener("click", (event) => {
      if (event.target === $("#palette")) closePalette();
    });
    $("#paletteInput").addEventListener("input", (event) => renderPalette(event.target.value));
    $("#paletteList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-palette]");
      if (!button) return;
      const item = $("#paletteList").__items?.[Number(button.dataset.palette)];
      if (item) item.run();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        openPalette();
      }
      if (event.key === "Escape") {
        closePalette();
        $("#scopeMenu").hidden = true;
        $("#scopeChip").setAttribute("aria-expanded", "false");
      }
      if (!$("#palette").hidden && event.key === "Enter") {
        const items = $("#paletteList").__items || [];
        if (items[0]) items[0].run();
      }
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────
  function boot() {
    // Mobile: a menu button opens the rail.
    const menuButton = document.createElement("button");
    menuButton.className = "icon-btn";
    menuButton.id = "menuBtn";
    menuButton.setAttribute("aria-label", "打开导航");
    menuButton.innerHTML = '<i data-lucide="menu"></i>';
    $(".top-actions").prepend(menuButton);
    menuButton.addEventListener("click", () => $("#app").classList.toggle("rail-open"));

    renderMiniReports();
    renderLibrary();
    renderThread();
    updateReportCount();
    paint();
    icons();
    bind();

    if (anime) {
      anime.animate(".empty-state > *", {
        opacity: [0, 1],
        y: [14, 0],
        duration: 520,
        delay: anime.stagger(60),
        ease: "outCubic"
      });
    }
  }

  boot();
})();
