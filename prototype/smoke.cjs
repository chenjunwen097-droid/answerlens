// Prototype smoke test: drives the new layout through its main flows.
// Run with: node prototype/smoke.cjs
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");
const { chromium } = require("playwright");

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;

(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch {
    browser = await chromium.launch({ headless: true, channel: "msedge" });
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  const qaDir = path.join(__dirname, "qa");
  fs.mkdirSync(qaDir, { recursive: true });

  await page.goto(pathToFileURL(path.join(__dirname, "index.html")).href);
  await page.waitForSelector("#emptyState:not([hidden])");
  await page.waitForTimeout(700);

  assert((await page.locator("#composer").count()) === 1, "prototype must render exactly one composer");
  await page.screenshot({ path: path.join(qaDir, "01-home.png") });

  // A suggestion fills the composer, then Enter sends it.
  await page.locator("[data-prompt]").first().click();
  assert((await page.locator("#input").inputValue()).length > 10, "suggestion did not fill the composer");
  await page.click("#sendBtn");
  await page.waitForSelector('[data-card-action="start-analysis"]');
  assert((await page.locator(".msg.is-user").count()) === 1, "user message was not rendered");
  await page.screenshot({ path: path.join(qaDir, "02-plan.png") });

  // Run the analysis and wait for the report artifact.
  await page.click('[data-card-action="start-analysis"]');
  await page.waitForSelector("#artifact:not([hidden])");
  await page.waitForFunction(() => Boolean(document.querySelector("#artifactBody [data-report-open]")), null, {
    timeout: 15000
  });
  const scope = (await page.locator("#scopeLabel").innerText()).trim();
  assert(scope.includes("报告"), `scope chip did not switch to the report: ${scope}`);
  await page.screenshot({ path: path.join(qaDir, "03-analysis-done.png") });

  // Open the report; the composer must stay visible.
  await page.click("#artifactBody [data-report-open]");
  await page.waitForSelector("#reportView:not([hidden])");
  assert(await page.locator("#composer").isVisible(), "composer disappeared in the report view");
  await page.waitForTimeout(1100);
  const score = Number(await page.locator("#reportScore").innerText());
  assert(score > 0 && score <= 100, `score did not animate to a real value: ${score}`);
  assert((await page.locator("#reportBars .bar-row").count()) === 3, "competitor bars did not render");
  await page.screenshot({ path: path.join(qaDir, "04-report.png") });

  // Report detail tab.
  await page.click('[data-tab="detail"]');
  assert((await page.locator(".detail-item").count()) === 6, "question detail did not render six questions");
  await page.screenshot({ path: path.join(qaDir, "05-detail.png") });

  // Library + filters.
  await page.click('.rail-item[data-view="library"]');
  await page.waitForSelector("#libraryView:not([hidden])");
  const cards = await page.locator(".report-card").count();
  assert(cards >= 6, `library is missing reports: ${cards}`);
  await page.click('[data-filter="high"]');
  const highCards = await page.locator(".report-card").count();
  assert(highCards < cards && highCards > 0, "high-score filter did not narrow the library");
  await page.screenshot({ path: path.join(qaDir, "06-library.png") });

  // Open a card, ask about the report, and get an answer in the artifact panel.
  await page.click('[data-filter="all"]');
  await page.locator(".report-card").first().click();
  await page.waitForSelector("#reportView:not([hidden])");
  await page.fill("#input", "第 2 题为什么得分低？");
  await page.click("#sendBtn");
  await page.waitForSelector(".artifact-msg");
  await page.waitForFunction(
    () => /表现最好/.test(document.querySelector("#artifactBody").innerText),
    null,
    { timeout: 6000 }
  );
  await page.screenshot({ path: path.join(qaDir, "07-report-chat.png") });

  // Command palette.
  await page.keyboard.press("Control+k");
  await page.waitForSelector("#palette:not([hidden])");
  await page.screenshot({ path: path.join(qaDir, "08-palette.png") });
  await page.keyboard.press("Escape");

  // Mobile layout still has exactly one composer.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  assert((await page.locator("#composer").count()) === 1, "mobile must not duplicate the composer");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  assert(!overflow, "mobile layout has horizontal overflow");
  await page.screenshot({ path: path.join(qaDir, "09-mobile.png") });

  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  await browser.close();
  console.log("prototype smoke passed");
})().catch((error) => {
  console.error(error);
  if (browser) browser.close().catch(() => {});
  process.exitCode = 1;
});
