#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";
import { generateObject, type ModelMessage } from "ai";
import { google } from "@ai-sdk/google";
import { z } from "zod";

type Severity = "P0" | "P1" | "P2";

type Finding = {
  surface: string;
  severity: Severity;
  check: string;
  detail: string;
};

type ViewportSpec = {
  name: string;
  width: number;
  height: number;
};

type Step = {
  type: "goto" | "wait" | "waitFor" | "waitForText" | "click" | "fill" | "press" | "hover" | "screenshot" | "assertVisible" | "assertText";
  path?: string;
  selector?: string;
  text?: string;
  value?: string;
  key?: string;
  name?: string;
  optional?: boolean;
  timeoutMs?: number;
};

type Scenario = {
  name?: string;
  description?: string;
  localStorage?: Record<string, string>;
  steps: Step[];
  mobileSteps?: Step[];
};

type BrowserEvidence = {
  schema: 1;
  runId: string;
  generatedAt: string;
  appUrl: string;
  capture: {
    storageState?: string;
    savedStorageState?: string;
    urlRedacted: boolean;
  };
  scenario: {
    name: string;
    description?: string;
  };
  viewports: Array<{
    name: string;
    width: number;
    height: number;
    screenshots: string[];
    videoPath?: string;
    textLength: number;
    scrollWidth: number;
    clientWidth: number;
    focusableCount: number;
    contrastFails: Array<{ selector: string; ratio: number; size: number }>;
    reducedMotionIssues: string[];
    findings: Finding[];
  }>;
  findings: Finding[];
};

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";

  try {
    if (command === "capture") {
      await captureCommand(args.slice(1));
    } else if (command === "judge") {
      await judgeCommand(args.slice(1));
    } else if (command === "scorecard") {
      scorecardCommand(args.slice(1));
    } else {
      printHelp();
      process.exit(command === "help" || command === "--help" || command === "-h" ? 0 : 1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exit(1);
  }
}

async function captureCommand(inputArgs: string[]) {
  const url = optionValue(inputArgs, "--url");
  const scenarioPath = optionValue(inputArgs, "--scenario");
  if (!url) throw new Error("--url is required");
  if (!scenarioPath) throw new Error("--scenario is required");

  const runId = optionValue(inputArgs, "--run-id") ?? timestampId(new Date());
  const outDir = resolve(optionValue(inputArgs, "--out") ?? join("out", runId));
  const viewports = optionValues(inputArgs, "--viewport").map(parseViewport);
  const storageStatePath = optionValue(inputArgs, "--storage-state");
  const saveStorageStatePath = optionValue(inputArgs, "--save-storage-state");
  const headed = hasFlag(inputArgs, "--headed");
  if (!viewports.length) {
    viewports.push(
      { name: "desktop-1440", width: 1440, height: 900 },
      { name: "mobile-430", width: 430, height: 932 },
    );
  }

  const scenario = readJson<Scenario>(scenarioPath);
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({ headless: !headed });
  const viewResults: BrowserEvidence["viewports"] = [];
  const allFindings: Finding[] = [];
  try {
    for (const viewport of viewports) {
      const result = await runViewport(browser, url, scenario, viewport, outDir, {
        storageStatePath,
        saveStorageStatePath,
        multipleViewports: viewports.length > 1,
      });
      viewResults.push(result);
      allFindings.push(...result.findings);
    }
  } finally {
    await browser.close();
  }

  const redactedUrl = redactUrl(url);
  const evidence: BrowserEvidence = {
    schema: 1,
    runId,
    generatedAt: new Date().toISOString(),
    appUrl: redactedUrl,
    capture: {
      storageState: storageStatePath ? displayPath(storageStatePath) : undefined,
      savedStorageState: saveStorageStatePath ? displayPath(saveStorageStatePath) : undefined,
      urlRedacted: redactedUrl !== url,
    },
    scenario: {
      name: scenario.name ?? basenameWithoutExt(scenarioPath),
      description: scenario.description,
    },
    viewports: viewResults,
    findings: allFindings,
  };

  const evidencePath = join(outDir, "browser-evidence.json");
  writeJson(evidencePath, evidence);
  writeFileSync(join(outDir, "summary.md"), renderEvidenceSummary(evidence));
  console.log(`wrote ${displayPath(evidencePath)}`);
  console.log(`findings=${allFindings.length} p0=${allFindings.filter((finding) => finding.severity === "P0").length} p1=${allFindings.filter((finding) => finding.severity === "P1").length}`);
}

type CaptureBrowserOptions = {
  storageStatePath?: string;
  saveStorageStatePath?: string;
  multipleViewports: boolean;
};

async function runViewport(browser: Browser, baseUrl: string, scenario: Scenario, viewport: ViewportSpec, outDir: string, options: CaptureBrowserOptions): Promise<BrowserEvidence["viewports"][number]> {
  const viewportDir = join(outDir, viewport.name);
  mkdirSync(viewportDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    recordVideo: { dir: viewportDir, size: { width: viewport.width, height: viewport.height } },
    storageState: options.storageStatePath ? resolve(options.storageStatePath) : undefined,
  });
  await context.addInitScript("window.__name = window.__name || ((fn) => fn);");
  await context.addInitScript(({ localStorageValues }) => {
    try {
      for (const [key, value] of Object.entries(localStorageValues as Record<string, string>)) {
        localStorage.setItem(key, value);
      }
    } catch {
      // Best effort setup only.
    }
    const state = { cls: 0, longTasks: 0 };
    Object.defineProperty(window, "__visualJudgeMetrics", { value: state, configurable: true });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const layout = entry as PerformanceEntry & { value?: number; hadRecentInput?: boolean };
          if (!layout.hadRecentInput && typeof layout.value === "number") state.cls += layout.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    } catch {
      // Browser may not expose layout-shift in this context.
    }
    try {
      new PerformanceObserver((list) => {
        state.longTasks += list.getEntries().length;
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Browser may not expose longtask in this context.
    }
  }, { localStorageValues: scenario.localStorage ?? {} });

  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });

  const findings: Finding[] = [];
  const screenshots: string[] = [];
  const steps = viewport.name.toLowerCase().includes("mobile") && scenario.mobileSteps?.length ? scenario.mobileSteps : scenario.steps;
  for (const [index, step] of steps.entries()) {
    try {
      const screenshot = await runStep(page, baseUrl, step, viewportDir, index);
      if (screenshot) screenshots.push(displayPath(screenshot));
    } catch (error) {
      const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
      findings.push({
        surface: viewport.name,
        severity: step.optional ? "P2" : "P0",
        check: `step:${step.type}`,
        detail: `${step.name ?? step.selector ?? step.text ?? step.path ?? index}: ${detail}`,
      });
      if (!step.optional) break;
    }
  }

  const signals = await readSignals(page);
  findings.push(...findingsForSignals(viewport.name, signals));
  const finalShot = join(viewportDir, "final.png");
  await page.screenshot({ path: finalShot, fullPage: false });
  screenshots.push(displayPath(finalShot));
  const video = page.video();
  if (options.saveStorageStatePath) {
    const statePath = storageStateOutputPath(options.saveStorageStatePath, viewport.name, options.multipleViewports);
    mkdirSync(dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
  }
  await context.close();
  const videoPath = video ? await video.path().catch(() => undefined) : undefined;

  return {
    name: viewport.name,
    width: viewport.width,
    height: viewport.height,
    screenshots,
    videoPath: videoPath ? displayPath(videoPath) : undefined,
    textLength: signals.textLength,
    scrollWidth: signals.scrollWidth,
    clientWidth: signals.clientWidth,
    focusableCount: signals.focusableCount,
    contrastFails: signals.contrastFails,
    reducedMotionIssues: signals.reducedMotionIssues,
    findings,
  };
}

async function runStep(page: Page, baseUrl: string, step: Step, outDir: string, index: number): Promise<string | undefined> {
  const timeout = step.timeoutMs ?? 7000;
  if (step.type === "goto") {
    await page.goto(resolveUrl(baseUrl, step.path), { waitUntil: "domcontentloaded", timeout });
    return undefined;
  }
  if (step.type === "wait") {
    await page.waitForTimeout(Number(step.value ?? 500));
    return undefined;
  }
  if (step.type === "waitFor") {
    await locatorFor(page, step).waitFor({ state: "visible", timeout });
    return undefined;
  }
  if (step.type === "waitForText") {
    if (!step.text) throw new Error("waitForText requires text");
    await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
    return undefined;
  }
  if (step.type === "click") {
    await locatorFor(page, step).click({ timeout });
    return undefined;
  }
  if (step.type === "fill") {
    if (step.value === undefined) throw new Error("fill requires value");
    await locatorFor(page, step).fill(step.value, { timeout });
    return undefined;
  }
  if (step.type === "press") {
    if (!step.key) throw new Error("press requires key");
    await locatorFor(page, step).press(step.key, { timeout });
    return undefined;
  }
  if (step.type === "hover") {
    await locatorFor(page, step).hover({ timeout });
    return undefined;
  }
  if (step.type === "screenshot") {
    const name = safeName(step.name ?? `step-${String(index + 1).padStart(2, "0")}`);
    const path = join(outDir, `${name}.png`);
    await page.screenshot({ path, fullPage: false });
    return path;
  }
  if (step.type === "assertVisible") {
    await locatorFor(page, step).waitFor({ state: "visible", timeout });
    return undefined;
  }
  if (step.type === "assertText") {
    if (!step.text) throw new Error("assertText requires text");
    await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
    return undefined;
  }
  return undefined;
}

function locatorFor(page: Page, step: Step) {
  if (step.selector) return page.locator(step.selector).first();
  if (step.text) return page.getByText(step.text, { exact: false }).first();
  throw new Error(`${step.type} requires selector or text`);
}

async function readSignals(page: Page) {
  return page.evaluate(() => {
    const visible = (element: Element) => {
      const rect = (element as HTMLElement).getBoundingClientRect();
      return rect.width > 2 && rect.height > 2 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= innerHeight && rect.left <= innerWidth;
    };
    const luminance = (color: string) => {
      const match = color.match(/rgba?\(([^)]+)\)/);
      if (!match) return undefined;
      const [r, g, b] = match[1].split(",").map((part) => Number.parseFloat(part.trim()) / 255);
      if ([r, g, b].some((value) => !Number.isFinite(value))) return undefined;
      const convert = (value: number) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
    };
    const backgroundFor = (element: Element) => {
      let node: Element | null = element;
      while (node) {
        const bg = getComputedStyle(node).backgroundColor;
        const alpha = Number.parseFloat(bg.match(/rgba?\([^,]+,[^,]+,[^,]+,\s*([^)]+)\)/)?.[1] ?? "1");
        if (alpha >= 0.95) return bg;
        node = node.parentElement;
      }
      return "rgb(17, 20, 24)";
    };
    const contrastFails: Array<{ selector: string; ratio: number; size: number }> = [];
    for (const element of Array.from(document.querySelectorAll("button, a, input, textarea, [role='button'], td, th, p, span, h1, h2, h3")).filter(visible).slice(0, 500)) {
      const text = (element.textContent ?? "").trim();
      if (!text && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) continue;
      const style = getComputedStyle(element);
      if (style.backgroundImage && style.backgroundImage !== "none") continue;
      const fg = luminance(style.color);
      const bg = luminance(backgroundFor(element));
      if (fg === undefined || bg === undefined) continue;
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const bold = Number.parseInt(style.fontWeight, 10) >= 700;
      const min = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5;
      if (ratio + 0.05 < min) {
        const className = typeof (element as HTMLElement).className === "string" ? (element as HTMLElement).className.split(/\s+/)[0] : "";
        contrastFails.push({
          selector: `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`,
          ratio: Math.round(ratio * 100) / 100,
          size: Math.round(size),
        });
      }
    }
    const reducedMotionIssues = Array.from(document.querySelectorAll<HTMLElement>("*")).filter(visible).slice(0, 500).filter((element) => {
      const style = getComputedStyle(element);
      const animationMs = parseCssTime(style.animationDuration);
      const transitionMs = parseCssTime(style.transitionDuration);
      return animationMs > 80 || transitionMs > 250;
    }).slice(0, 8).map((element) => {
      const className = typeof element.className === "string" ? element.className.split(/\s+/)[0] : "";
      return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}`;
    });
    const focusable = Array.from(document.querySelectorAll<HTMLElement>("button, [href], input, textarea, select, [tabindex]:not([tabindex='-1'])")).filter(visible);
    return {
      textLength: document.body.innerText.trim().length,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      focusableCount: focusable.length,
      contrastFails,
      reducedMotionIssues,
    };
    function parseCssTime(value: string) {
      return Math.max(0, ...value.split(",").map((raw) => raw.trim()).map((raw) => raw.endsWith("ms") ? Number.parseFloat(raw) : raw.endsWith("s") ? Number.parseFloat(raw) * 1000 : 0).filter(Number.isFinite));
    }
  });
}

function findingsForSignals(surface: string, signals: Awaited<ReturnType<typeof readSignals>>): Finding[] {
  const findings: Finding[] = [];
  if (signals.textLength < 80) findings.push({ surface, severity: "P0", check: "near-blank-render", detail: `${signals.textLength} visible text characters` });
  if (signals.scrollWidth > signals.clientWidth + 2) findings.push({ surface, severity: "P1", check: "horizontal-overflow", detail: `${signals.scrollWidth - signals.clientWidth}px overflow` });
  if (!signals.focusableCount) findings.push({ surface, severity: "P1", check: "keyboard-focus", detail: "no visible focusable controls" });
  for (const fail of signals.contrastFails.slice(0, 8)) {
    findings.push({ surface, severity: fail.ratio < 3 ? "P1" : "P2", check: "contrast", detail: `${fail.selector} ${fail.ratio}:1 at ${fail.size}px` });
  }
  for (const selector of signals.reducedMotionIssues) {
    findings.push({ surface, severity: "P1", check: "reduced-motion", detail: `${selector} keeps long motion under prefers-reduced-motion` });
  }
  return findings;
}

async function judgeCommand(inputArgs: string[]) {
  const mediaPath = optionValue(inputArgs, "--media");
  if (!mediaPath) throw new Error("--media is required");
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is required");
  const outPath = resolve(optionValue(inputArgs, "--out") ?? join("out", "gemini-review.json"));
  const model = optionValue(inputArgs, "--model") ?? process.env.GEMINI_VISUAL_JUDGE_MODEL ?? "gemini-3.5-flash";
  const bytes = readFileSync(mediaPath);
  const mediaType = mediaTypeFor(mediaPath);
  const result = await generateObject({
    model: google(model),
    schema: judgeSchema,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: judgePrompt },
        { type: "file", data: bytes, filename: basename(mediaPath), mediaType },
      ],
    } satisfies ModelMessage],
    temperature: 0.2,
  });

  const review = normalizeJudge(result.object);
  const out = {
    generatedAt: new Date().toISOString(),
    model,
    mediaPath,
    mediaType,
    review,
  };
  writeJson(outPath, out);
  writeFileSync(outPath.replace(/\.json$/i, ".md"), renderJudgeSummary(out));
  console.log(`wrote ${displayPath(outPath)}`);
  console.log(`${review.verdict}: ${review.summary}`);
}

const scoreSchema = z.object({
  score: z.number().min(0).max(2),
  evidence: z.string(),
});

const judgeSchema = z.object({
  verdict: z.enum(["pass", "fix", "rework"]),
  summary: z.string(),
  scores: z.object({
    visualHierarchy: scoreSchema,
    layoutIntegrity: scoreSchema,
    interactionClarity: scoreSchema,
    legibility: scoreSchema,
    responsiveFit: scoreSchema,
    workflowCompleteness: scoreSchema,
    productionHonesty: scoreSchema,
    evidenceQuality: scoreSchema,
  }),
  observedEvidence: z.array(z.string()).default([]),
  missingEvidence: z.array(z.string()).default([]),
  defects: z.array(z.object({
    ts: z.string(),
    severity: z.enum(["P0", "P1", "P2"]),
    observed: z.string(),
    fix: z.string(),
  })).default([]),
});

type JudgeReview = z.infer<typeof judgeSchema>;

const judgePrompt = [
  "You are a strict visual QA judge for a browser-recorded web app walkthrough.",
  "Judge only what is visible in the attached media. Do not infer success from text claims unless the UI visibly shows the state, artifact, or result.",
  "Compare the app against polished professional software: clear hierarchy, obvious active state, readable dense data, stable layout, no empty dead zones, no accidental overlap, and low-friction workflow.",
  "",
  "Score each dimension from 0 to 2:",
  "0 = absent or broken, 1 = acceptable but weak, 2 = strong and clearly visible.",
  "",
  "Defect severity:",
  "P0 blocks trusting or using the UI.",
  "P1 should be fixed before calling the experience polished.",
  "P2 is polish or follow-up.",
  "",
  "Return strict JSON matching the schema. Use concrete timestamps when video time is visible; use 'n/a' otherwise.",
].join("\n");

function normalizeJudge(review: JudgeReview): JudgeReview {
  const scores = { ...review.scores };
  for (const key of Object.keys(scores) as Array<keyof typeof scores>) {
    const raw = scores[key].score;
    scores[key] = { ...scores[key], score: Number(Math.max(0, Math.min(2, raw > 2 ? raw / 5 : raw)).toFixed(2)) };
  }
  return { ...review, scores };
}

function scorecardCommand(inputArgs: string[]) {
  const evidencePath = optionValue(inputArgs, "--evidence");
  if (!evidencePath) throw new Error("--evidence is required");
  const judgePath = optionValue(inputArgs, "--judge");
  const outPath = resolve(optionValue(inputArgs, "--out") ?? join(dirname(evidencePath), "scorecard.md"));
  const evidence = readJson<BrowserEvidence>(evidencePath);
  const judge = judgePath ? readJson<{ review: JudgeReview; model?: string }>(judgePath) : undefined;
  const p0 = evidence.findings.filter((finding) => finding.severity === "P0").length + (judge?.review.defects.filter((defect) => defect.severity === "P0").length ?? 0);
  const p1 = evidence.findings.filter((finding) => finding.severity === "P1").length + (judge?.review.defects.filter((defect) => defect.severity === "P1").length ?? 0);
  const verdict = p0 ? "rework" : p1 ? "fix" : judge?.review.verdict ?? "pass";
  const markdown = renderScorecard(evidence, judge, verdict);
  writeFileSync(outPath, markdown);
  console.log(`wrote ${displayPath(outPath)}`);
  console.log(`verdict=${verdict} p0=${p0} p1=${p1}`);
}

function renderEvidenceSummary(evidence: BrowserEvidence): string {
  const lines = [
    "# Browser Evidence",
    "",
    `Generated: ${evidence.generatedAt}`,
    `Run: \`${evidence.runId}\``,
    `Scenario: \`${evidence.scenario.name}\``,
    `App URL: ${evidence.appUrl}`,
    "",
    "## Viewports",
    "",
    "| Viewport | Size | Text | Overflow | Focusable | Screenshots | Video | Findings |",
    "|---|---:|---:|---:|---:|---:|---|---:|",
  ];
  for (const viewport of evidence.viewports) {
    const overflow = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    lines.push(`| ${viewport.name} | ${viewport.width}x${viewport.height} | ${viewport.textLength} | ${overflow}px | ${viewport.focusableCount} | ${viewport.screenshots.length} | ${viewport.videoPath ? "`yes`" : "`no`"} | ${viewport.findings.length} |`);
  }
  lines.push("", "## Findings", "");
  if (!evidence.findings.length) lines.push("(none)");
  for (const finding of evidence.findings) lines.push(`- **${finding.severity}** ${finding.surface} / ${finding.check}: ${finding.detail}`);
  lines.push("");
  return lines.join("\n");
}

function renderJudgeSummary(out: { generatedAt: string; model: string; mediaPath: string; review: JudgeReview }): string {
  const lines = [
    "# Gemini Visual Judge",
    "",
    `Generated: ${out.generatedAt}`,
    `Model: \`${out.model}\``,
    `Media: \`${out.mediaPath}\``,
    "",
    `Verdict: \`${out.review.verdict}\``,
    "",
    out.review.summary,
    "",
    "## Scores",
    "",
    "| Dimension | Score | Evidence |",
    "|---|---:|---|",
  ];
  for (const [dimension, value] of Object.entries(out.review.scores)) lines.push(`| ${dimension} | ${value.score}/2 | ${escapeMd(value.evidence)} |`);
  lines.push("", "## Defects", "");
  if (!out.review.defects.length) lines.push("(none)");
  for (const defect of out.review.defects) lines.push(`- **${defect.severity}** @ ${defect.ts}: ${defect.observed} -> ${defect.fix}`);
  lines.push("");
  return lines.join("\n");
}

function renderScorecard(evidence: BrowserEvidence, judge: { review: JudgeReview; model?: string } | undefined, verdict: string) {
  const lines = [
    "# Visual QA Scorecard",
    "",
    `Verdict: \`${verdict}\``,
    `Scenario: \`${evidence.scenario.name}\``,
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Deterministic Browser Evidence",
    "",
    ...renderEvidenceSummary(evidence).split("\n").slice(9),
  ];
  lines.push("", "## Gemini Judge", "");
  if (!judge) {
    lines.push("No Gemini judge file attached.");
  } else {
    lines.push(`Model: \`${judge.model ?? "unknown"}\``);
    lines.push(`Verdict: \`${judge.review.verdict}\``);
    lines.push("");
    lines.push(judge.review.summary);
    lines.push("");
    for (const defect of judge.review.defects) lines.push(`- **${defect.severity}** @ ${defect.ts}: ${defect.observed} -> ${defect.fix}`);
  }
  lines.push("");
  return lines.join("\n");
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveUrl(baseUrl: string, path?: string) {
  if (!path || path === "." || path === "./") return baseUrl;
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith("/")) return new URL(path, baseUrl).toString();

  const base = new URL(baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  base.search = "";
  base.hash = "";
  return new URL(path, base).toString();
}

function storageStateOutputPath(path: string, viewportName: string, multipleViewports: boolean) {
  const absolute = resolve(path);
  if (!multipleViewports) return absolute;
  const ext = extname(absolute);
  const base = ext ? absolute.slice(0, -ext.length) : absolute;
  return `${base}.${safeName(viewportName)}${ext || ".json"}`;
}

function parseViewport(value: string): ViewportSpec {
  const match = value.match(/^([a-zA-Z0-9_-]+):(\d+)x(\d+)$/);
  if (!match) throw new Error(`Invalid viewport "${value}". Use name:WIDTHxHEIGHT`);
  return { name: match[1], width: Number(match[2]), height: Number(match[3]) };
}

function mediaTypeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".webm") return "video/webm";
  throw new Error(`Unsupported media extension: ${ext}`);
}

function optionValue(inputArgs: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = inputArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  if (inline !== undefined) return inline;
  const index = inputArgs.indexOf(name);
  if (index === -1) return undefined;
  const value = inputArgs[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function optionValues(inputArgs: string[], name: string): string[] {
  const values: string[] = [];
  const prefix = `${name}=`;
  for (let index = 0; index < inputArgs.length; index += 1) {
    const arg = inputArgs[index];
    if (arg.startsWith(prefix)) {
      values.push(arg.slice(prefix.length));
      continue;
    }
    if (arg === name) {
      const value = inputArgs[index + 1];
      if (value && !value.startsWith("--")) {
        values.push(value);
        index += 1;
      }
    }
  }
  return values;
}

function hasFlag(inputArgs: string[], name: string) {
  return inputArgs.includes(name);
}

function timestampId(date: Date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function safeName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "screenshot";
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

function basenameWithoutExt(path: string) {
  const name = basename(path);
  return name.replace(/\.[^.]+$/, "");
}

function displayPath(path: string) {
  const root = process.cwd();
  const absolute = isAbsolute(path) ? path : resolve(path);
  return relative(root, absolute).replace(/\\/g, "/") || ".";
}

const sensitiveQueryName = /(auth|token|code|state|session|secret|password|pass|key|credential)/i;

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    for (const key of Array.from(url.searchParams.keys())) {
      if (sensitiveQueryName.test(key)) url.searchParams.set(key, "[redacted]");
    }
    return url.toString();
  } catch {
    return value;
  }
}

function escapeMd(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function printHelp() {
  console.log([
    "Visual Judge",
    "",
    "Commands:",
    "  visual-judge capture --url=<url> --scenario=<file> [--out=<dir>] [--viewport=name:WIDTHxHEIGHT] [--storage-state=<file>] [--save-storage-state=<file>] [--headed]",
    "  visual-judge judge --media=<png|jpg|webp|mp4|mov|webm> [--out=<json>] [--model=<gemini-model>]",
    "  visual-judge scorecard --evidence=<browser-evidence.json> [--judge=<gemini-review.json>] [--out=<md>]",
  ].join("\n"));
}

await main();
