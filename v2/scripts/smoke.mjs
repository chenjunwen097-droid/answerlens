// End-to-end smoke for the v2 shell. Start the app first: npm run dev
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const base = process.env.BASE_URL || "http://127.0.0.1:3100";
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForSelector(".empty-state");
  assert((await page.locator("#input").count()) === 1, "composer is missing");

  await page.locator(".suggestions button").first().click();
  assert((await page.locator("#input").inputValue()).length > 10, "suggestion did not fill the composer");
  await page.locator("#sendBtn").click();
  await page.waitForSelector(".msg-card button");
  assert((await page.locator(".msg.is-user").count()) === 1, "user message missing");

  await page.locator(".msg-card button").click();
  await page.waitForURL(/\/reports\/[^/]+/, { timeout: 30000 });
  await page.waitForSelector(".report-view");
  await page.waitForTimeout(1200);
  assert((await page.locator("#input").count()) === 1, "composer disappeared on the report page");
  const score = Number(await page.locator(".score-ring strong").innerText());
  assert(score > 0 && score <= 100, `score not animated: ${score}`);
  assert((await page.locator(".bar-row").count()) === 3, "bars missing");

  const artifactWidth = await page.evaluate(() => {
    const panel = document.querySelector(".artifact");
    return panel ? Math.round(panel.getBoundingClientRect().width) : 0;
  });
  assert(artifactWidth >= 270 && artifactWidth <= 290, `artifact is not 280px: ${artifactWidth}`);

  await page.getByRole("tab", { name: "提问明细" }).click();
  assert((await page.locator(".detail-item").count()) === 6, "detail list missing");

  await page.goto(`${base}/reports`, { waitUntil: "networkidle" });
  const cards = await page.locator(".report-card").count();
  assert(cards >= 6, `library is missing reports: ${cards}`);
  await page.locator(".segmented button").nth(1).click();
  const high = await page.locator(".report-card").count();
  assert(high > 0 && high < cards, "score filter did not narrow the library");

  await page.locator(".report-card").first().click();
  await page.waitForSelector(".report-view");
  await page.locator("#input").fill("第 2 题为什么得分低？");
  await page.locator("#sendBtn").click();
  await page.waitForSelector(".artifact-msg");
  await page.waitForFunction(
    () => document.querySelectorAll(".artifact-msg").length >= 2 && !document.body.innerText.includes("正在查看"),
    null,
    { timeout: 15000 }
  );
  assert((await page.locator(".artifact").isVisible()), "report chat panel missing");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  assert((await page.locator("#input").count()) === 1, "mobile duplicated the composer");
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  assert(!overflow, "mobile has horizontal overflow");

  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);
  console.log("v2 smoke passed");
} finally {
  await browser.close();
}
