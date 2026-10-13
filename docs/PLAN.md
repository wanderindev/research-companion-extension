# PIC Extension — Plan

## Goal

Automate the semi-manual steps of the PIC blog research pipeline end to end:

1. Pick an APPROVED article suggestion that has no research yet.
2. Generate its research prompt (server-side, existing endpoint).
3. Drive claude.ai: new chat → Chat mode → Sonnet / medium effort → enable Research → paste prompt → send → dismiss the connectors modal ("Disable all tools" + Confirm).
4. Wait 15–40 minutes for the deep research to complete.
5. Extract the research markdown and upload it to the PIC admin API (existing upload endpoint, which validates word count / references / sub-topic coverage).

Two more processes (feature images, TBD) will be automated later on the same skeleton.

**Process 1b — deep-research fact-check (added 2026-07-12):** the same pipeline
parameterized as a second run type (`runType: 'fact_check'`). The web-search
fact-check tier (panama-in-context epic #373) marks claims it can't resolve
`NEEDS_DEEP_RESEARCH`; the extension batches them into a verification prompt
(new endpoints from panama-in-context PR #383, see docs/pic-api.md §4–6), runs
deep research, and uploads the `VERDICT:`-line document back, echoing the
batch's `claim_ids`. Steps 3–4 (claude.ai driving, polling, extraction) are
shared with research runs unchanged — the verdict doc is a normal deep-research
artifact. Articles and easy facts never reach the extension (grounding and
web-search tiers handle them server-side).

Since panama-in-context #390 made extract-only the default fact-check mode,
one research doc yields 100–200 pending claims, so fact-check runs
**auto-continue** (issue #9): after each successful verdict upload the run
chains the next ≤25-claim batch (fresh conversation, previous batch's tab
closed once the new one exists) until the queue drains (generate-prompt 404),
every claim in a new batch was already attempted this run (unresolvable
retreads), or a 10-batch backstop. The 90-min research timeout is per batch
(`batchStartedAt`), totals accumulate across the chain, and dry run stays
single-batch.

## Key design decisions

### 1. No companion server (unlike the earlier extension)

The earlier internal extension needed a server because its task queue and multi-user coordination lived there. Here the "queue" already exists: the PIC database knows which suggestions are approved and unresearched, and the PIC admin API exposes everything we need. The extension talks **directly** to `https://panamaincontext.com/api/v1/admin/dashboard/*` from its service worker. One moving part fewer.

### 2. API-first against PIC; DOM automation only for claude.ai

Every PIC-side step (list suggestions, generate prompt, upload research) is a plain authenticated `fetch` — no DOM scraping of the admin panel. DOM automation is confined to claude.ai's composer, where no public API exists for deep research.

### 3. Piggyback on the admin panel's magic-link session

The admin panel stores its opaque bearer token in `sessionStorage` under `adminToken` (7-day lifetime, `ADMIN_LINK_VALIDITY` in PIC; revocable). A lightweight content script on `panamaincontext.com/admin*` reads it after the operator logs in and hands it to the extension, which caches it in `chrome.storage.session`/`local` with its expiry. All PIC API calls send `Authorization: Bearer <token>`. When the token is missing/expired the popup shows "Open the admin panel to sign in" — the extension never handles credentials itself.

CORS note: requests go out from the **service worker** with `host_permissions` for the API origin, so page CORS does not apply and no backend CORS change is needed (auth is a header, not a cookie).

### 4. Extract the research via claude.ai's internal API, not the Downloads folder

Recon confirmed (see `docs/claude-ai-recon.md`) that
`GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true`
returns the completed research artifact's **full markdown** in the `artifacts` tool_use block (`input.content`). So instead of clicking "Download as Markdown", finding `compass_artifact_*.md` in Downloads, and re-selecting it in a file picker, the extension:

- polls that endpoint (same-origin fetch from the claude.ai content script, session cookies included) to detect completion, and
- pulls the markdown straight out of the JSON, wraps it in a `File`, and POSTs it as multipart to the PIC upload endpoint.

No filesystem, no file picker, no `downloads` permission. DOM watching ("Research complete · N sources") remains as a fallback signal only.

### 5. Modern MV3, no build step

- Manifest V3, service worker with `"type": "module"`, vanilla ES modules. No bundler until we actually need one (the popup is simple HTML/JS).
- `host_permissions` limited to `https://claude.ai/*` and `https://panamaincontext.com/*` (plus localhost for dev). Content scripts match only those origins — not `<all_urls>` like the earlier extension.
- Long waits survive service-worker teardown via `chrome.alarms` + a single `executionState` object in `chrome.storage.local` (pattern lifted from the earlier extension).

### 6. Imitate the earlier extension's proven patterns, skip its baggage

Imitate: centralized selector registry, unified `findElement` with retries + descriptive logging, MutationObserver "settle" waits, synthetic `input` events for framework-controlled inputs, single persisted execution-state object, fail-safe teardown (mark run failed + close tab on unhandled errors).

Skip/avoid: companion server, `<all_urls>` injection, hand-edited dev/prod constant (use `chrome.storage`-backed settings + a visible dry-run toggle instead).

## Architecture

```
┌──────────────────────────── Chrome ────────────────────────────┐
│                                                                │
│  Popup UI ──────────────┐                                      │
│   pick suggestion,      │ runtime messages                     │
│   start run, progress   ▼                                      │
│  Service worker (orchestrator, ES module)                      │
│   • state machine in chrome.storage.local (executionState)     │
│   • PIC API client (fetch + Bearer token)                      │
│   • chrome.alarms for poll ticks & timeouts                    │
│   • opens/closes the claude.ai tab                             │
│      ▲ token push                    │ commands / ▲ status     │
│      │                               ▼                         │
│  Content script:                Content script:                │
│  panamaincontext.com/admin*     claude.ai/*                    │
│   • read sessionStorage          • composer automation         │
│     adminToken → storage           (selector registry)         │
│                                  • connectors-modal handling   │
│                                  • completion polling via      │
│                                    same-origin internal API    │
│                                  • artifact markdown extract   │
└────────────────────────────────────────────────────────────────┘
                 │                                │
                 ▼                                ▼
   PIC admin API (documented in       claude.ai web app + internal
   docs/pic-api.md)                   API (documented in
                                      docs/claude-ai-recon.md)
```

### Run state machine (persisted after every transition)

```
idle
 → fetching_suggestions      GET  suggestions/available-for-research
 → awaiting_selection        (popup; or "auto: newest" toggle)
 → generating_prompt         POST research/generate-prompt {suggestion_id}
 → opening_claude            create claude.ai/new tab, wait for content script ready
 → composing                 ensure Chat mode · Sonnet · medium effort · Research on
 → sending                   insert prompt, click Send
 → dismissing_connectors     modal: "Disable all tools" → Confirm
 → researching               record conversation UUID; poll every 60 s (alarm),
                             hard timeout 90 min
 → extracting                pull artifact markdown from conversation JSON
 → uploading                 POST research/upload (multipart file + suggestion_id)
 → done | failed             persist outcome + error detail; notify
```

Failure at any step records the step, error, and (when on claude.ai) a DOM snapshot summary to ease selector-drift diagnosis. A `dry_run` setting stops after `composing` without sending (the earlier extension's dev "click cancel instead of save" idea, made explicit).

### Edge cases to handle

- **Token expired mid-run** (7-day window since the token TTL change, run is ~40 min — rare but possible if started late): upload fails 401 → keep the extracted markdown in `chrome.storage.local`, prompt operator to re-login, retry upload only.
- **Upload 400** (validation failed: <4000 words, missing references, sub-topics): surface the structured `detail` (message/checks/word_count) in the popup; keep the markdown for manual retry. Note the server auto-appends a references section via Haiku when missing, so most soft failures self-heal server-side.
- **Upload 409** (research already APPROVED): never auto-`force=true`; surface and let the operator decide.
- **Research run dies on claude.ai** (stopped, errored, usage limit): detect assistant message ending without an `artifacts` tool_use, or an error banner; mark failed with reason.
- **Connectors modal variants**: the modal only appears when connectors are enabled on the account; treat it as optional (wait up to ~20 s, proceed if absent).
- **Concurrent runs**: refuse to start a run while `executionState.phase != idle | done | failed`.
- **Pacing gate (deferred)**: the admin UI disables Generate Prompt until all non-REJECTED research is APPROVED with all articles published (`AdminResearch.jsx` `canGenerate`) — a UI-only gate the API doesn't enforce. Decision (2026-07-12): the extension will replicate this wait-for-completed-work behavior, but only AFTER end-to-end testing is done (a separate fact-checking agent is being built to accelerate research approval). Until then the extension intentionally bypasses it.

## Repo layout (target)

```
pic-extension/
  manifest.json
  src/
    background/
      index.js            # orchestrator / state machine
      pic-api.js          # PIC admin API client
      state.js            # executionState accessors (chrome.storage.local)
    content/
      admin-token.js      # panamaincontext.com/admin* token capture
      claude/
        index.js          # message handler / step runner
        selectors.js      # centralized selector registry
        dom-utils.js      # findElement + retries, synthetic input events
        wait-utils.js     # MutationObserver settle, retryOperation
        claude-api.js     # same-origin internal API calls (poll, extract)
    popup/
      popup.html / popup.js / popup.css
    shared/
      messages.js         # message type constants
      log.js
  docs/
    PLAN.md  claude-ai-recon.md  pic-api.md
  CLAUDE.md
  .claude/settings.json
```

## Milestones → GitHub issues

1. **Scaffold** — manifest, directory layout, load-unpacked instructions, ESLint (flat config), CI lint on PR.
2. **PIC auth + API client** — token-capture content script, storage with expiry, API client, popup that lists suggestions available for research (proves auth end to end).
3. **Prompt → composer** — generate-prompt call; claude.ai content script composes (mode/model/effort/Research toggle/insert/send) and handles the connectors modal (selectors captured in recon doc §2). Includes one **live calibration run** to validate modal timing and the tool-count-pill rows' response to "Disable all tools". `dry_run` setting ships here.
4. **Poll → extract → upload** — alarm-driven polling, artifact extraction, multipart upload, structured error surfacing. First fully automated research, end to end.
5. **Hardening** — state recovery after browser restart, retries, timeout handling, chrome.notifications on done/failed, run history in popup.
6. **Process 2 / Process 3** — reuse skeleton (separate issues once specified).

## Risks

| Risk | Mitigation |
|------|------------|
| claude.ai UI drift breaks selectors | single selector registry; text+testid dual strategies; descriptive per-step failure logs |
| Internal conversation API changes (undocumented) | DOM fallback for completion detection; extraction fallback = click `[data-testid="export-download"]` and read via `chrome.downloads` as last resort |
| Connectors modal drift / tool-count rows untested | selectors captured (recon §2); milestone 3 calibration run validates behavior; modal treated as optional with timeout; never enable "Always allow" |
| MV3 worker killed during 40-min wait | alarms + persisted state; every poll tick re-reads state from storage |
| Anti-bot / Cloudflare on internal API from worker context | all claude.ai fetches run in the content script (page origin, real session) |
