# NODE-LOOPS.md — visual-judge

> This repo's self-improving-loop manifest. Companion to CLAUDE.md. Spec: https://github.com/HomenShum/noderl/blob/main/spec/node-loops.md

`CLAUDE.md` says how an agent behaves. This file says what loop the repo *runs*: a goal, an inner act/observe/judge cycle, and an outer self-heal cycle that turns judgments back into fixes.

visual-judge is itself a **node in someone else's loop**: it is the **separate verifier** for a web app's frontend/UI. A coding agent ships UI; visual-judge records that UI in a real browser, judges it like a strict product reviewer, and emits a verdict + concrete defects. It is the reward/verification signal for "does the UI actually look and work right" — deliberately decoupled from the app's own claims of success.

Everything below is grounded in the real repo. Primary source is a single CLI: [`src/cli.ts`](src/cli.ts) (capture / judge / scorecard), with [`README.md`](README.md), [`package.json`](package.json), and [`examples/`](examples/).

---

## 1. Goal & milestones

**Goal.** Turn vague "this looks wrong" into reproducible, severity-tagged UI/UX defects, by judging the *visible* workflow of a web app against polished professional software — not by trusting the app's own status text. (README "Philosophy"; [`src/cli.ts`](src/cli.ts) `judgePrompt`.)

**What exists today (`v0.1.0`, [`package.json`](package.json)).** A three-command pipeline, one file, zero app coupling:
- `capture` — drive the app through a JSON scenario across viewports, write `browser-evidence.json` + `summary.md` + screenshots/video. ([`src/cli.ts`](src/cli.ts) `captureCommand` / `runViewport`.)
- `judge` — send the recorded media to Gemini, get a structured verdict + scores + defects. ([`src/cli.ts`](src/cli.ts) `judgeCommand`.)
- `scorecard` — merge deterministic findings + Gemini defects into one verdict-gated scorecard. ([`src/cli.ts`](src/cli.ts) `scorecardCommand`.)

**Milestones (honest; see §7).**
- M1 — capture + deterministic signals: **in repo.**
- M2 — Gemini media judge with strict JSON schema + score clamping: **in repo.**
- M3 — merged scorecard with P0/P1 gate: **in repo.**
- M4 — authenticated capture (storage-state, URL redaction): **in repo** ([`examples/agent-native-clips-library.json`](examples/agent-native-clips-library.json), README "Authenticated Apps").
- M5 — automated regression / self-test of the judge itself (tests, CI): **OPEN** (no test files, no `.github/workflows`).

---

## 2. Inner loop — act → observe → judge

One iteration = one walkthrough of a target web app.

**Act.** Drive the live app deterministically. A scenario is JSON (`goto`, `wait`, `waitFor`, `waitForText`, `click`, `fill`, `press`, `hover`, `screenshot`, `assertVisible`, `assertText`; each step may be `optional` with a `timeoutMs`). Runs per viewport — default `desktop-1440` (1440×900) and `mobile-430` (430×932), `mobileSteps` used when the viewport name contains "mobile". Playwright/Chromium with video recording and `reducedMotion: "reduce"`. ([`src/cli.ts`](src/cli.ts) `runViewport` / `runStep`; example [`examples/noderoom-gap-parity.json`](examples/noderoom-gap-parity.json).)

**Observe — input is media + DOM, not log lines.**
- **Deterministic layer** (`readSignals` → `findingsForSignals`): visible text length, horizontal overflow (`scrollWidth` vs `clientWidth`), focusable-control count, WCAG-style contrast ratios on real elements, and reduced-motion violations. A failed non-optional step is itself a **P0** finding. ([`src/cli.ts`](src/cli.ts) lines ~320–402, ~219–224.)
- **Evidence artifact**: `browser-evidence.json` (`schema: 1`) records per-viewport screenshots, video path, the raw signals, and all findings.

**Judge — this repo IS the separate verifier (reward source).** `judge` attaches the recorded media (png/jpg/webp/mp4/mov/webm) to **Gemini** (`@ai-sdk/google`, `generateObject`, default `gemini-3.5-flash`, `temperature: 0.2`) under a strict reviewer prompt. ([`src/cli.ts`](src/cli.ts) `judgeCommand`, `judgePrompt`, `judgeSchema`.)

- **Output = structured verdict, not prose.** `verdict ∈ {pass, fix, rework}`, plus eight 0–2 dimension scores each with `evidence`: `visualHierarchy`, `layoutIntegrity`, `interactionClarity`, `legibility`, `responsiveFit`, `workflowCompleteness`, `productionHonesty`, `evidenceQuality`; plus `observedEvidence`, `missingEvidence`, and timestamped `defects` (severity + observed + fix). (`judgeSchema`.)
- **Scoring rubric**: `0 = absent/broken, 1 = acceptable but weak, 2 = strong and clearly visible`; severities `P0` (blocks trusting the UI) / `P1` (fix before "polished") / `P2` (polish/follow-up). (`judgePrompt`.)

The verifier is **separate by construction**: it sees only recorded pixels + DOM signals, never the app's backend or success claims — the reward signal cannot be gamed by the app printing "Success".

---

## 3. Outer loop — verdicts feed back into fixes

**How verdicts return to the UI/demo.** `scorecard` fuses both layers into one human- and agent-readable artifact (`scorecard.md`) listing deterministic findings beside Gemini defects, each with a concrete `fix`. That defect list is the work queue the coding agent (governed by a future `CLAUDE.md`) acts on, then re-runs the inner loop to confirm the defect is gone. ([`src/cli.ts`](src/cli.ts) `scorecardCommand` / `renderScorecard`.)

**Promotion gate (real, in code).** The merged verdict is **deterministic-first**: any `P0` (browser *or* judge) ⇒ `rework`; else any `P1` ⇒ `fix`; else the Gemini verdict (default `pass`). A clean run is gated on **zero P0/P1**, not on the model feeling good. ([`src/cli.ts`](src/cli.ts) `scorecardCommand`, lines ~501–503.)

**Kill criteria.**
- Hard stop the walkthrough: a non-optional step fails ⇒ P0 + `break` (no point judging a broken flow). ([`src/cli.ts`](src/cli.ts) ~219–225.)
- Near-blank render (`textLength < 80`) ⇒ P0 (catches white-screen / un-hydrated shells).
- No Gemini key ⇒ `judge` throws; the pipeline still produces a deterministic-only scorecard rather than faking a verdict. ([`src/cli.ts`](src/cli.ts) `judgeCommand`, `scorecardCommand` with no `--judge`.)

---

## 4. Context anchors

| Anchor | Location | Notes |
|---|---|---|
| Entire engine | [`src/cli.ts`](src/cli.ts) | capture / judge / scorecard in one file |
| Judge prompt (rubric) | [`src/cli.ts`](src/cli.ts) `judgePrompt` | strict reviewer; 0–2 scale; P0/P1/P2 defs |
| Verdict schema | [`src/cli.ts`](src/cli.ts) `judgeSchema` / `scoreSchema` | 8 dims + defects, zod-validated |
| Deterministic checks | [`src/cli.ts`](src/cli.ts) `readSignals` / `findingsForSignals` | contrast, overflow, focus, reduced-motion, blank-render |
| Gate logic | [`src/cli.ts`](src/cli.ts) `scorecardCommand` | P0→rework / P1→fix |
| Scenario schema | [`src/cli.ts`](src/cli.ts) `Scenario`/`Step` types; README "Scenario Format" | 11 step types |
| Example scenarios | [`examples/noderoom-gap-parity.json`](examples/noderoom-gap-parity.json), [`examples/agent-native-clips-library.json`](examples/agent-native-clips-library.json) | desktop+mobile steps; auth flow |
| Config | [`.env.example`](.env.example) | `GOOGLE_GENERATIVE_AI_API_KEY`, `GEMINI_VISUAL_JUDGE_MODEL=gemini-3.5-flash` |
| Manifest / deps | [`package.json`](package.json) | `@ai-sdk/google`, `ai`, `@playwright/test`, `zod`; Node ≥22 |

**Absences (each a finding, not an omission):**
- **No `CLAUDE.md`** — agent-behavior companion does not yet exist; NODE-LOOPS.md is the first governance doc in the repo.
- **No tests / no CI** — no `*.test.ts`, no `.github/workflows/`. The verifier has no self-regression check (M5).
- **No separate rubric/prompt module** — the rubric lives inline in `judgePrompt`; there is no versioned prompt or golden-output fixture to diff against.

---

## 5. Verification protocol

- **Separate verifier.** The judge reads only recorded media + DOM-derived signals; it has no access to the app's backend or success messages. Reward signal is independent of the system under test.
- **Honest verdict (anti-cheat, in the prompt).** `judgePrompt`: *"Judge only what is visible in the attached media. Do not infer success from text claims unless the UI visibly shows the state, artifact, or result."* So a demo that *says* it worked but doesn't *show* it cannot earn `productionHonesty` or `workflowCompleteness` points. ([`src/cli.ts`](src/cli.ts).)
- **Bounded, validated scores.** All scores pass `judgeSchema` (zod) and `normalizeJudge` clamps every dimension to `[0,2]` (and rescales an out-of-range `>2` by /5) — the model cannot inflate past the ceiling. ([`src/cli.ts`](src/cli.ts) `normalizeJudge`.)
- **Deterministic floor wins ties.** The numeric P0/P1 finding count, not the model's mood, decides `rework`/`fix`; Gemini only sets the verdict when the deterministic layer is clean. ([`src/cli.ts`](src/cli.ts) `scorecardCommand`.)
- **Runtime reliability.** Per-step `timeoutMs` (default 7000 ms; `goto` waits `domcontentloaded`); browser/context always closed in `finally`; `localStorage`/PerformanceObserver init wrapped in `try/catch`; unsupported media extension throws explicitly. ([`src/cli.ts`](src/cli.ts) `runStep`, `runViewport`, `mediaTypeFor`.)
- **Gap:** no automated test exercising the judge/scorecard against a known-good vs known-bad fixture (see §4 absences, §7).
- **PROVE-BEFORE-CLAIM** (agent-side gate) — never assert done/pass/fixed/blocked/absent/"root cause" from a *proxy* (an affordance, a keyword/template echo, a rendered shell, or a prior-based hypothesis); name the artifact that proves it and check THAT, independent-confirm anything that "looks done", and treat no gate as real until the autonomous path is tried. Canonical gate + observed failure signals: https://github.com/HomenShum/noderl/blob/main/spec/prove-before-claim.md

## 6. Reward & safety

- **Reward shape.** Verdict ∈ {pass, fix, rework} + eight 0–2 scores + timestamped defects with fixes. The actionable reward is the defect list; the gate (§3) is the pass/fail signal.
- **No fabricated success.** Honesty rule (§5) + deterministic floor mean the loop cannot reward a UI that only *claims* to work. Missing-evidence is recorded explicitly (`missingEvidence` field).
- **Secret hygiene.** Auth-like URL query values (`auth|token|code|state|session|secret|password|pass|key|credential`) are redacted before evidence is written, so scorecards are shareable without leaking callback/session hints. ([`src/cli.ts`](src/cli.ts) `redactUrl`, `sensitiveQueryName`; README "Authenticated Apps".)
- **Credentials in env, not code.** `GOOGLE_GENERATIVE_AI_API_KEY` read from the environment; `judge` hard-fails if absent rather than degrading silently. ([`.env.example`](.env.example), [`src/cli.ts`](src/cli.ts).)
- **Read-only on the target.** The tool only drives and records the app; it writes nothing back to the system under test — only local `out/` artifacts.

## 7. Status / receipts

**PROVEN (present and wired in the repo — code-grounded, not run-verified here):**
- 3-command pipeline capture → judge → scorecard exists end-to-end in [`src/cli.ts`](src/cli.ts).
- Gemini structured judging with a strict 8-dimension rubric and zod schema + score clamping (`judgeSchema`, `judgePrompt`, `normalizeJudge`).
- Deterministic signal layer (blank-render, overflow, focus, contrast, reduced-motion) and step-failure findings.
- Verdict gate: P0→rework / P1→fix, deterministic-first (`scorecardCommand`).
- Honesty rule and secret redaction in code.
- Authenticated capture via Playwright storage-state, with two example scenarios.

**OPEN (honest gaps — no invented pass-rates or scores):**
- **No self-regression test / CI** for the verifier itself (M5). The judge's own reliability across model/prompt changes is unmeasured in-repo.
- **No `CLAUDE.md`** companion yet.
- **No golden-output fixtures** to detect prompt/model drift; rubric is inline and unversioned.
- **No published numbers.** This repo ships the loop's *machinery*; it does not assert any benchmark score or pass-rate. Any real verdict comes only from running the pipeline against a live app.

_Last grounded against `main` @ `bf31659`._
