# Visual Judge

Continuous browser walkthrough capture plus Gemini-backed visual QA judgment for web app UI/UX gaps.

Visual Judge is built for the review loop where a normal test suite is not enough:

- record the app through real browser actions across desktop and mobile viewports
- collect deterministic evidence such as screenshots, video paths, text density, overflow, focusable controls, contrast, and action failures
- ask Gemini to judge the visible workflow like a strict product reviewer
- aggregate both layers into a scorecard with concrete defects

It is intentionally not a replacement for functional tests. Use it beside Playwright assertions, CI, accessibility checks, and product gates.

## Install

```bash
npm install
npm run build
```

For Gemini review:

```bash
cp .env.example .env
# Fill GOOGLE_GENERATIVE_AI_API_KEY
```

or set the key in your shell:

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=...
```

PowerShell:

```powershell
$env:GOOGLE_GENERATIVE_AI_API_KEY="..."
```

## Capture A Walkthrough

```bash
npm run capture -- --url=http://127.0.0.1:5173 --scenario=examples/noderoom-gap-parity.json --out=out/noderoom
```

The capture command writes:

- `browser-evidence.json`
- `summary.md`
- viewport screenshots
- viewport videos when the browser supports recording

### Authenticated Apps

For apps behind login, first create a Playwright storage-state file with your
normal browser/login flow, then pass it to capture:

```bash
npm run capture -- \
  --url=https://clips.agent-native.com/library \
  --scenario=examples/agent-native-clips-library.json \
  --storage-state=.auth/clips.json \
  --out=out/clips-library
```

Use `--headed` when you need to watch the capture browser. Use
`--save-storage-state=.auth/clips.json` to write the session state back out after
the run; when multiple viewports run, Visual Judge writes one file per viewport
with the viewport name appended.

Evidence redacts auth-like URL query values such as `token`, `code`, `state`,
`session`, `key`, and `__an_auth_redirect`, so scorecards can be shared without
leaking callback/session hints.

If the scenario's first `goto` step omits `path`, Visual Judge opens the exact
`--url` value. That is useful for signed or redirect URLs such as Agent-Native
Clips library links.

## Judge Media With Gemini

```bash
npm run judge -- --media=out/noderoom/desktop-1440/video.webm --out=out/noderoom/gemini-review.json
```

The judge only scores visible evidence. It should not infer backend success from UI claims.

## Build A Scorecard

```bash
npm run scorecard -- --evidence=out/noderoom/browser-evidence.json --judge=out/noderoom/gemini-review.json --out=out/noderoom/scorecard.md
```

Without a Gemini file, the scorecard still reports deterministic browser findings:

```bash
npm run scorecard -- --evidence=out/noderoom/browser-evidence.json --out=out/noderoom/scorecard.md
```

## Scenario Format

Scenarios are JSON files with setup and step actions:

```json
{
  "name": "example",
  "description": "Open a route, perform actions, and record proof.",
  "localStorage": {
    "tour": "done"
  },
  "steps": [
    { "type": "goto", "path": "/?mode=memory" },
    { "type": "click", "selector": "[data-testid='start-demo-room']", "optional": true },
    { "type": "waitFor", "selector": "[data-testid='artifact-panel']" },
    { "type": "screenshot", "name": "room-shell" }
  ]
}
```

Supported step types:

- `goto`
- `wait`
- `waitFor`
- `waitForText`
- `click`
- `fill`
- `press`
- `hover`
- `screenshot`
- `assertVisible`
- `assertText`

Every step can include `optional: true` and `timeoutMs`.

## Philosophy

Gemini is useful as a visual critic, not as the source of truth. Visual Judge treats model review as one evidence layer and keeps deterministic browser findings beside it so teams can turn vague "this looks wrong" feedback into reproducible fixes.
