# Research Companion Extension

> **📌 This is a snapshot, as of October 2026, of an active private project.** The live repository stays private; this snapshot exists so the architecture and code can be discussed openly. It is not developed here and accepts no pull requests.

## What is this?

A Chrome extension (Manifest V3, internally named **PIC Companion**) that gives two UI-only tools an API, **Claude's deep research** and **Grammarly's editor**, and uses them to automate the slowest human loops in the [Panama In Context](https://panamaincontext.com) content factory. It drives claude.ai and Grammarly in the operator's own logged-in browser session, talks to the platform's admin API for everything that *does* have an API, and turns each copy-paste-wait loop into one click.

It's a small codebase, about 3,300 lines of vanilla JavaScript with no build step and no framework, but the pattern generalizes: **any capability that only exists behind a UI can be given an API** if you're willing to treat the browser as the runtime.

**📖 Read the full project write-up at [feliu.dev/projects/pic-companion](https://feliu.dev/projects/pic-companion)**, or browse the same pages here in [`docs/project-writeup/`](docs/project-writeup/README.md): APIfying deep research, the crash-safe run state machine, the self-chaining fact-check drain, driving Grammarly, and what a robot may accept.

The platform this extension drives has its own public snapshot: [**ai-powered-content-generation-engine**](https://github.com/wanderindev/ai-powered-content-generation-engine).

## What it does

One popup, three run types:

- **Research runs.** Pick an approved article suggestion; the extension asks the backend for a deep-research prompt, opens claude.ai, composes and sends the research (verifying model, effort and the Research toggle on the way), dismisses the connectors modal, polls until the research completes, extracts the report markdown through claude.ai's conversation API, and uploads it back for validation and review.
- **Fact-check runs.** Drains the pipeline's *needs deep research* claim queue: fetch a batch of up to 25 claims as a verification prompt, run it through deep research, upload the verdicts, and **chain the next batch automatically** until the queue is empty.
- **Grammar runs.** Proofread a batch of 1 to 10 items, where each item is one article in one language. For each one the extension fetches the article body as HTML, pastes it into a fresh Grammarly document, accepts suggestions under a per-language policy, runs Grammarly's Humanizer, makes a second accept pass, reads the result back out of the editor with a strict serializer, and sends it to the backend, which checks every changed paragraph for a change in meaning before writing it.

All three share a **dry-run mode (on by default)**. For the deep-research runs it performs every step up to, but never including, pressing Send; for grammar runs it accepts nothing and checks that the article survives the round trip through Grammarly unchanged. All three survive popup close, tab close and Chrome killing the service worker mid-run (which MV3 does constantly; see the write-up for the keepalive, watchdog and detached-loop design).

## How the code is organized

```
manifest.json                MV3 manifest (host permissions: the PIC site, claude.ai, Grammarly)
src/background/              Service worker: run state machines, PIC API client
  run.js                     Research and fact-check runs, shared run helpers, watchdog
  grammar-run.js             Grammar runs: queue, per-language policy, item phases
  grammar-guards.js          Pure pre-paste checks (heading levels)
src/content/admin-token.js   Captures the admin session token from the PIC admin SPA
src/content/claude/          claude.ai driver: selector registry, DOM utils,
                             composer automation, internal-API report extraction
src/content/grammarly/       Grammarly driver: selectors, paste, accept loop,
                             Humanizer, strict DOM-to-HTML serializer
src/popup/                   The one-popup UI and the per-item grammar audit
src/shared/                  Message contracts between the pieces
tests/                       node --test suites for the pure helpers
docs/PLAN.md                 Architecture and design decisions
docs/grammar-check-plan.md   Design of the grammar run type, with as-built notes
docs/claude-ai-recon.md      Live-captured claude.ai selector and internal-API notes
docs/grammarly-recon.md      Live-captured Grammarly editor notes
docs/pic-api.md              Admin API endpoint contracts
docs/project-writeup/        The 5-part write-up published on feliu.dev
CLAUDE.md                    Project constitution for AI-assisted development
```

Conventions worth noting: every site's selectors live in **one registry file per site**, with a human-readable description used in logs (never inlined in flow code); all run state is persisted so any phase can resume after a service worker death; and minutes-long page work runs detached in the tab while the worker polls it, never as one awaited message.

## Development

```bash
npm install        # dev tooling only (ESLint); the extension has no build step
npm run lint
npm test
```

Load it: `chrome://extensions` → enable Developer mode → **Load unpacked** → select this repo's root. After editing the service worker or `manifest.json`, hit the extension's reload button; content-script changes also require reloading the target tab.

The extension is a pure client of the Panama In Context admin API: running it end to end requires an admin session on that platform, so out of the box this repo is best read as a reference implementation of the browser-as-runtime pattern.

## License

Released under the [MIT No Attribution License](LICENSE) (MIT-0): use, copy, modify, and redistribute this code however you wish, commercially or not, with no attribution required.
