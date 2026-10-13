# claude.ai recon notes

Captured live on 2026-07-12 against claude.ai (logged-in Max account, dark theme, desktop). These selectors feed `src/content/claude/selectors.js`. Re-verify when automation starts failing — this file is the living registry's documentation.

## 1. Composer (`claude.ai/new`)

| Element | Selector | Notes |
|---|---|---|
| Prompt input | `[data-testid="chat-input"]` | `div.tiptap.ProseMirror`, `contenteditable`, aria-label "Write your prompt to Claude" |
| Chat / Cowork toggle | `span[role="radio"]` with text `Chat` / `Cowork` | `aria-checked` reflects state; each wraps a hidden `<input type=radio>`; default = Chat |
| Model selector | `[data-testid="model-selector-dropdown"]` | `aria-label` mirrors selection, e.g. "Model: Sonnet 5 Medium" — cheap way to verify state without opening the menu |
| Model options (menu open) | `[role="menuitemradio"]` with text starting `Sonnet 5` / `Opus 4.8` / `Haiku 4.5` / `Fable 5` | `aria-checked="true"` on current |
| Effort submenu trigger | `[data-testid="effort-menu-trigger"]` | inside model menu; text "Effort<current>" |
| Effort options | `[data-testid="effort-option-low"]`, `effort-option-medium`, `effort-option-high` | menuitemradio, `aria-checked` |
| “+” tools menu | `button[aria-label="Add files, connectors, and more"]` | `aria-haspopup="menu"` |
| Research toggle (menu open) | `[data-testid="add-menu-research"]` (fallback `[role="menuitemcheckbox"]` with text `Research`) | `aria-checked` reflects on/off; sibling checkbox `Web search` |
| Send | `button[aria-label="Send message"]` | only exists once the input has content |
| File upload input | `input[data-testid="file-upload"]` | not needed for this flow |

Element `id`s (`base-ui-_r_*_`, `_r_*_`) are runtime-generated — never use them.

### Inserting the prompt

`document.execCommand('insertText', false, text)` on the focused `chat-input` correctly updates ProseMirror/React state (verified: send button appears). Plain `textContent` assignment would not. Clear with `execCommand('selectAll')` + `execCommand('delete')`.

### Desired pre-send state for the research flow

1. Chat radio `aria-checked="true"` (default).
2. Model = Sonnet, effort = medium (current account default — verify via the model button's `aria-label`, only open the menu if it differs).
3. Research menuitemcheckbox `aria-checked="true"` (must toggle each new chat).

### Timing lessons (2026-07-12 calibration)

- On cold loads the content script (and its ping) are ready **long before React paints the composer** — automation must gate on `[data-testid="chat-input"]` appearing (up to ~60 s) before its first lookup, or element finds lose the race.
- The Chat/Cowork toggle should be treated as **optional** — absence means the plain chat composer; don't fail on it.
- End-to-end compose→send→modal-dismissal validated live 2026-07-12 (dry run + full run).

## 2. Connectors modal (post-send)

Captured from operator-provided HTML + screenshot, 2026-07-12. Appears a few seconds after sending a Research chat. Base UI portal near `<body>`.

| Element | Selector | Notes |
|---|---|---|
| Dialog | `[role="dialog"][data-cds="Dialog"]` whose text matches `/Enable connectors for Claude to use in research/i` | title is an `<h2>` inside; `aria-labelledby` id is runtime-generated |
| Disable all tools | `span[data-cds="TextLink"][role="button"]` with text `Disable all tools` | a span, **not** a `<button>`/`<a>` |
| Connector rows | `<button>` per connector, containing a `<p>` with the name and a `span[role="switch"][data-cds="Switch"][aria-label="<name>"]` | the switch span sits inside `<span inert>` — it is decorative/non-interactive; **the row `<button>` is the toggle target**. State read via the switch's `aria-checked` |
| Tool-count rows | some connectors (e.g. Linear) show a `39 of 50` count pill instead of a switch | ✅ verified 2026-07-12: "Disable all tools" turns these off too — every row disabled |
| "Always allow N selected connectors" | `span[role="switch"]` labelled by the `Always allow…` label text, NOT inert | must stay `aria-checked="false"` — never enable, or the modal (our safety gate) stops appearing |
| Confirm | `button[data-cds="Button"]` with text `Confirm`, scoped to the dialog | `aria-keyshortcuts="Enter"` was the hook until 2026-09-21, then disappeared; the label is now the only stable signal (attribute kept as fallback) |
| Cancel | `button[data-cds="Button"]` with text `Cancel` | |

Dismissal sequence:
1. Wait for the dialog (up to ~20 s after send); if it never appears, proceed — accounts without connectors don't get it.
2. Click "Disable all tools".
3. Verify every connector-row switch inside the dialog list is `aria-checked="false"`; retry stragglers by clicking their row button. Confirm what happens to count-pill rows.
4. Assert the "Always allow" switch is still off.
5. Click Confirm; wait for the dialog to be removed from the DOM.

A live calibration run (milestone 3) still validates timing and the count-pill behavior, but the selectors are known.

## 3. Completion detection

The research progress panel renders as a `<button>` (expandable) whose text contains `Research complete · <n> sources · <duration>` when finished. During the run it shows progressive status text instead. DOM signal = fallback; primary signal is the internal API (below).

## 4. Internal API (primary poll/extract path)

Same-origin `fetch` from the claude.ai tab (content script), session cookies ride along automatically. All verified working 2026-07-12:

- `GET /api/organizations` → `[{uuid, name, capabilities}, ...]`. Pick the org whose `capabilities` includes `chat` (the `api`-only org is the Console account).
- Conversation UUID: from the tab URL after send — `claude.ai/chat/<uuid>`.
- `GET /api/organizations/{org}/chat_conversations/{uuid}?tree=True&rendering_mode=messages&render_all_tools=true` → `{chat_messages: [...]}`.
  - Each message: `{sender: "human"|"assistant", content: [...], stop_reason}`.
  - The completed research artifact is a `content` block: `{type: "tool_use", name: "artifacts", input: {id, type, title, command, content, language, md_citations, version_uuid}}` — **`input.content` is the full research markdown** (verified 48,730 chars on a real completed research).
  - **Deep research is ASYNC — `stop_reason` does NOT mean the report is ready.** The assistant emits `{type: "tool_use", name: "launch_extended_search_task"}` and its `tool_result` comes back _immediately_ carrying only `{"task_id": "wf-<uuid>"}` (this id is the `compass_artifact_wf-<uuid>_…md` download filename). The turn then ends with `stop_reason: "end_turn"` **while the research is still running**, and the `artifacts` block is appended to that same message minutes later when the report lands. A conversation mid-research therefore looks like: `tool_use:launch_extended_search_task`, `tool_result:launch_extended_search_task`, `stop_reason: end_turn`, **no artifact and no text blocks**.
  - Completion heuristic: **any** assistant message contains an `artifacts` tool_use with non-empty `input.content` (`input.content` is the full research markdown; verified 48,730 chars on one run, 15,381 on another).
  - Running heuristic: no artifact yet but a `launch_extended_search_task` block is present → research in flight, keep polling regardless of `stop_reason`. Bound it with a wall-clock timeout, never with a poll count.
  - Failure heuristic: `stop_reason` present, **no research task launched**, and no artifacts block → inspect trailing text blocks for the error/stop reason. (Treating "ended + no artifact" as failure without checking for the research task fails every research that outlives the poll budget — this cost three healthy runs on 2026-07-13/14.)

## 5. Artifact drawer (manual-download fallback only)

Clicking the artifact card (plain `div` with click handler — no button role; match by title text) opens the right drawer:

| Element | Selector |
|---|---|
| Copy split-button caret | `button[aria-label="Copy options"]` (`aria-haspopup="menu"`) |
| Download as Markdown | `[data-testid="export-download"]` (role menuitem) |
| Download as PDF | menuitem with text `Download as PDF` (no testid) |
| Close drawer | `button[aria-label="Close artifact"]` |

Downloaded filename starts with `compass_artifact_`. Only needed if the internal API path (§4) breaks.

## 6. Misc

- New-chat URL: `https://claude.ai/new`. After send it becomes `https://claude.ai/chat/<uuid>` — capture via `tabs.onUpdated` or content-script `location` watch.
- Menus close on `Escape` (dispatch `keydown` on `document.body`).
- Modals/menus are Base UI portals appended near `<body>` — query globally, not inside the composer subtree.

## Icon-font glyphs in text (2026-09-21)

Menu items and the Chat/Cowork radios now embed their icons as icon-font
glyphs in the Private Use Area (U+E000–U+F8FF) inside `textContent`, e.g.
`"\uE0D0Research"`, `"\uE002Web search\uE03B"` (trailing glyph = the check
mark), `"\uE0xxChat"`. `PIC.dom.visibleText` strips them before any `text`
regex is tested, so selector regexes stay written against the visible label.
The "+" menu items also gained `data-testid="add-menu-*"` ids
(`add-menu-research`, `add-menu-web-search`, `add-menu-upload-file`, …).
