# PIC Extension — Project Constitution

## What this is

A Chrome extension (Manifest V3) that automates semi-manual steps of the Panama In Context content pipelines. It drives claude.ai in the operator's logged-in browser session (deep research has no public API) and calls the PIC admin API directly for everything else. **Read `docs/PLAN.md` first** — it holds the architecture and design decisions. `docs/claude-ai-recon.md` (live-captured selectors + internal API) and `docs/pic-api.md` (endpoint contracts) are the working references.

## Related repos (often added as extra working dirs)

- `~/vc/panama-in-context` — the PIC monorepo. Source of truth for the admin API (`backend/app/api/dashboard.py`, `auth.py`) and the admin SPA auth (`frontend/src/contexts/AdminAuthProvider.jsx`, `frontend/src/services/admin.js`). When an API question comes up, read the code there rather than trusting docs here.
- An earlier internal MV3 site-automation extension serves as reference architecture only. We imitate its selector registry / findElement retries / MutationObserver waits / persisted executionState; we do NOT copy its companion server or `<all_urls>` injection.

## Conventions

- Manifest V3; service worker is an ES module; vanilla JS ES modules, no bundler, no framework. Keep it that way unless a milestone genuinely needs more.
- All claude.ai selectors live in ONE file (`src/content/claude/selectors.js`) and all Grammarly selectors in `src/content/grammarly/selectors.js` — one registry per site: `src/content/claude/selectors.js`, each entry with a human-readable `description` used in logs. Never inline a selector in flow code. Never use claude.ai's runtime-generated element ids (`_r_*_`).
- Prefer `data-testid` and `aria-label` selectors; text-match (`role` + visible text) as the fallback strategy.
- All claude.ai internal-API fetches run in the claude.ai content script (same-origin, session cookies). All PIC API fetches run in the service worker (host_permissions bypass CORS; auth = `Authorization: Bearer` from the captured admin token).
- Every state transition of a run is persisted immediately to `chrome.storage.local` (`executionState`) — assume the service worker can be killed at any moment.
- The extension must never handle PIC credentials: it only reuses the `adminToken` the admin SPA put in `sessionStorage`. If the token is missing/expired, tell the operator to open the admin panel.
- `dry_run` setting: composes on claude.ai but never clicks Send. Use it for all selector work.

## Dev workflow

- Load unpacked: `chrome://extensions` → Developer mode → Load unpacked → repo root.
- After editing the service worker or manifest, click the extension's reload button; content-script changes also need a page reload on the target tab.
- Live DOM verification of selectors is done with the claude-in-chrome browser tools against a real claude.ai session; update `docs/claude-ai-recon.md` when reality drifts.
- A full end-to-end test triggers a real deep research (15–40 min, consumes claude.ai usage) — prefer `dry_run`, which tests everything up to Send, and say in the report when a live run happened and on which article.
- GitHub: repo `wanderindev/pic-extension`; use `gh` for issues/PRs. Work in feature branches; PRs to `main`.

## Agentic protocols

- If you learn a persistent pattern about this codebase, update this file.
- Selector drift diagnosis: reproduce with claude-in-chrome, fix `selectors.js`, then sync `docs/claude-ai-recon.md`.

## Process 2 — Grammarly (added 2026-09-20)

- Plan + design decisions: `docs/grammar-check-plan.md`; DOM recon: `docs/grammarly-recon.md`.
- `src/background/grammar-run.js` owns the `grammar` run type; `run.js` only dispatches to it (`startRun`, `watchdog`) and exports the shared helpers. Grammar phases are all worker-bound. **Never await a minutes-long content-script command over one `chrome.tabs.sendMessage`**: the MV3 worker can restart mid-call, and the fresh worker then treats the item as orphaned (that shipped as "applies two fixes, then opens the next article"). The accept loop is start + `accept-status` polling for exactly that reason.
- `src/content/grammarly/serializer.js` is STRICT: unknown nodes throw. Extend it only after checking the node in a live doc and recording it in the recon doc.
- Accept policy lives in `DEFAULT_POLICY` (`grammar-run.js`) and can be overridden per install via `picSettings.grammarPolicy` (an override wins over the defaults, so check it before reading a run's behaviour off the code). Since 2026-09-27 both languages accept Grammar, Clarity and Delivery, relying on PIC's Sonnet meaning check (#518, recalibrated in PIC #544) to revert claim changes. "Check wording" stays denied everywhere, and "Rewrite the sentence" stays denied in ES. The link guard covers Humanizer cards only, not the accept loop.
- Humanizer (#21): `humanize` / `humanize-status` in the content script, same detached + polled shape as `accept`. A bare `.click()` does not open a rewrite card — `pointerClick()` (pointer + mouse event sequence) does. Both side panels stay in the DOM; Humanizer selectors are anchored on `data-coda-ui-id="ai-editor-text-decoration#humanizer-…"`, never on the proofread `feed-card`s.
- Dry run pastes, reads back and calls `grammar-apply` with `dry_run: true`; `changed: false` is the serializer's acceptance test. Run it on real articles before turning dry run off.

## Shipping

Merging happens only through GitHub auto-merge, which fires once the required
check **`lint`** passes (the job runs both lint and the `node --test` suite).
Never merge by hand: no `--admin`, no merge API call.

**Before the PR** — mirror `.github/workflows/ci.yml` locally (Node 22):

```bash
npm ci
npm run lint        # eslint src tests eslint.config.js
npm test            # node --test "tests/**/*.test.js"
```

If the change touches selectors or a run flow, also do a `dry_run` pass in the
loaded extension (see Dev workflow) before opening the PR; a green CI says
nothing about live DOM drift.

**What merging does** — deploys nothing. There is no build, no store listing
and no update channel: the operator runs the extension unpacked from a local
checkout, so a merge reaches the browser only when that checkout is updated and
the extension reloaded.

**Deploy / verify** — after merge, pull `main` in the local checkout, then tell
the operator: "reload PIC Companion at `chrome://extensions`" (plus "reload the
claude.ai / Grammarly / admin tab" when a content script changed). Note whether
the change needs a PIC backend deploy or migration first (e.g. a new
`pic-api.md` endpoint) — that ships from `panama-in-context`, not here.

**No operator gate** (operator decision 2026-10-12). Agents may start live
(non-`dry_run`) runs, change `manifest.json` permissions or host_permissions,
and override `picSettings` on the installed extension. A live run (real deep
research, or a Grammarly accept/apply) writes to production content and spends
claude.ai usage, so the report says what ran and on which articles.
