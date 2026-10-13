# Process 2 — Grammarly proofread of blog articles (EN + ES)

Status: **implemented 2026-09-20** (PIC PR #517 endpoints + this repo's `feat/grammar-check`) and in production use. The live dry run on real articles and the automation of the operator's **Humanizer → "everyday voice"** pass (rail button `button[aria-label="Humanizer"]`, §4.3) both landed across this repo's PRs #14 to #36. Supersedes the
"drive the Grammarly *extension*" idea that was abandoned because one extension
cannot reach another's UI. This version drives Grammarly's **web editor** instead
(`app.grammarly.com/ddocs/new` → `coda.grammarly.com/d/...`), which is an ordinary
page a content script can control.

Related: PIC issue #409/#410 (LLM grammar check — judged not good enough, stage
disabled via `weekly_plan_grammar_checks_enabled=False`), pic-extension #6
("Processes 2–3"), PIC `CLAUDE.md` § "Grammar check".

---

## 1. What the operator does today (the thing we are automating)

1. Open the article in the admin Edit drawer, copy the **rich text** out of the TipTap
   editor — **only the article body**, skipping the auto-generated
   `**About this Article**` block at the top and the `**Continue Reading**` block at
   the bottom (Spanish: `**Acerca de este artículo**` / `**Continuar leyendo**`).
2. Open `app.grammarly.com/ddocs/new`, paste, accept the suggestions one by one.
3. Copy the corrected rich text back into the drawer, over the body only, save. The
   drawer PUTs `content_html`, and the backend's `html_to_markdown` turns it back into
   markdown.
4. Repeat for `content_es`.

Requirements from the operator:

- Must work **without the admin dashboard open** → the extension talks to the API.
- Conversion must be the *same* markdown ↔ rich text logic PIC uses, so we never
  need to teach the accept loop about markdown syntax characters.
- EN and ES.
- Articles with empty `grammar_checked_en_at` / `grammar_checked_es_at` are the
  backlog. Every one of them is already complete, i.e. **already carries the series
  sections** — those must be left byte-for-byte untouched.
- The popup should surface the backlog and offer Start, like the fact-check row.

---

## 2. Live recon of `coda.grammarly.com` (verified 2026-09-20 with claude-in-chrome)

All of this was exercised on a real doc, not read from docs. Anchor on the
`data-testid`, `role`, `kr-*` classes and button labels below; the hashed classes
(`_root_hblmT_root`, `zNvSLmyz`) churn on their deploys.

### 2.1 Page shape

| Thing | Finding |
|---|---|
| New doc | `GET https://app.grammarly.com/ddocs/new` redirects (~3 s) to `https://coda.grammarly.com/d/Untitled-doc_<id>/Untitled-page_<id>#_<cursor>`. The URL then re-titles itself from the first heading (`/d/Panama-s-Bastioned-Walls_<id>/...`). Match on `coda.grammarly.com/d/*`. |
| Editor | Exactly **one** `div[contenteditable="true"][data-editable-id="root"][role="textbox"]` (Slate). No iframes, no shadow DOM. |
| Suggestion cards | `[data-testid="feed-card"]`, inside `[data-testid="scroll-container"]`. Collapsed cards have `role="button"`; the expanded one gains a class containing `isExpanded` and exposes real `<button>`s labelled **Accept** and **Dismiss**. `h2` = "Suggestion for <snippet>", `h3` = type ("Add a comma", "Improve wording", "Rewrite the sentence", "Punctuation problem"). |
| Category pills | `All <n>`, `Grammar <n>`, `Clarity <n>`, `Delivery <n>` under the **Proofread** tab; a separate **Strengthen writing** tab (ignore it). |
| Score | "Overall score <n>" in the header; "Writing quality <n>" in the sidebar. Useful as a log metric and a "checking finished" signal (it is `--` while analysing). |
| Noise | A dismissible "Try our AI detection" promo at the bottom of the sidebar. Ignore. |
| Network | Traffic goes to `gateway.grammarly.com`, `goldengate.grammarly.com`, `ai-editor.femetrics.grammarly.io`. **We do not touch their API** — DOM only. |

### 2.2 Verified interactions

| Action | How | Result |
|---|---|---|
| Insert rich text | focus editor, collapse selection to end, `dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt}))` with `dt.setData('text/html', html)` | `h2/h3`, `strong`, `em`, `a`, `ul/ol/li`, `blockquote`, `p` all rendered correctly. |
| Insert plain text | same with `text/plain` only | works (used only for a smoke test). |
| Expand a card | `card.click()` | card becomes expanded, Accept/Dismiss appear. |
| Accept | `[...expanded.querySelectorAll('button')].find(b => b.innerText.trim() === 'Accept').click()` | editor text changed, card count 40 → 39. ⚠ This was run once on the operator's real doc: "In the last article we left" gained a comma. |
| Undo | Ctrl+Z | works. |
| Copy out via `copy` event | `dispatchEvent(new ClipboardEvent('copy', {clipboardData: dt}))` | **does not work** — Slate marks it handled but writes nothing into the synthetic `DataTransfer`. `navigator.clipboard.read()` hung under CDP (permission prompt). → Read the DOM instead (§2.3). |

### 2.3 Editor DOM → HTML (the read-back serializer)

Top-level children of the editor are the blocks. Each carries stable semantic
classes on top of the hashed ones:

| Block | Tag + classes |
|---|---|
| Heading | `h2.kr-h2`, `h3.kr-h3` (assume `h1.kr-h1`, `h4.kr-h4` — verify) |
| Paragraph | `div.kr-paragraph` |
| Bullet item | `div.kr-ulist.kr-listitem` (one block per item; group consecutive items into one `<ul>`) |
| Numbered item | `div.kr-olist.kr-listitem` (same, `<ol>`) |
| Quote | `blockquote` |
| Inline text | `span.kr-span`, with `kr-bold` / `kr-italic` modifiers; link = `a[href]` (wrapped in a `var[contenteditable=false]`) |
| Skip | anything inside `[data-editable-ignore-node]` (block gutter widgets), `span.kr-hidden-child` (zero-width joiner after links), `[data-canvas-placement-block]` wrapper attrs |

Not yet observed: `hr`, code / code block, images, tables, underline, strike.
The serializer must run in **strict mode**: an unrecognised block or inline node
fails the run with the offending outerHTML in `errorDetail`, never a silent drop.

Plain `innerText` of the editor is also available and is enough for the
"nothing changed" assertion below.

### 2.4 Open recon items (do before coding the content script)

1. ~~Spanish~~ — auto-detected per doc, no setting (operator-confirmed).
2. ~~`h1`, `h4`, `hr`, inline code, code block~~ — recorded in `grammarly-recon.md` §3.
3. Whether "Rewrite the sentence" / "Improve wording" accepts ever split or merge
   **blocks** (paragraph count before/after). The apply endpoint will reject a
   block-count change anyway; this just decides whether those types are accepted
   by default.
4. Card lazy-rendering: all 40 cards were in the DOM on a 2,790-word doc; check a
   4,000-word one.
5. How to delete a doc (header `…` → Delete → in-page modal). Optional; see §5.5.

---

## 3. PIC side — what exists and what is missing

Verified against `~/vc/panama-in-context` (paths relative to `backend/`):

- `articles.grammar_checked_en_at` / `_es_at` exist (migration `0024_grammar_check`),
  are returned by `GET /admin/dashboard/articles` (`ArticleListItem`, alongside
  `has_content`, `has_spanish`, `has_series_sections`, `status`), and are written by
  **exactly one** place: `services/grammar_check.py::run_grammar_check` (the LLM pass).
- Markdown ↔ HTML is **server-side only**: `app/utils/markdown.py::markdown_to_html`
  (python-markdown `fenced_code, tables, toc, nl2br, sane_lists` + `nh3` allowlist) and
  `html_to_markdown` (`markdownify(heading_style="ATX", bullets="-", strong_em_symbol="*")`).
  The frontend ships no markdown library; the drawer just loads `content_html` into
  TipTap and PUTs `content_html` back. **So "the exact logic" is two Python
  functions, and the only faithful way to reuse them is an endpoint.**
- The round trip is normalising, not byte-stable (`nl2br` `<br/>`, `---` → `* * *`,
  `***bold***`, whitespace). The drawer already lives with that (it has a 500 ms
  "stabilising" window after load for this reason), and every manual Grammarly pass
  so far went through the same two functions, so the normalisation is *already* in
  the data. We still guard against it: §4.2 dry-run compares before any accept.
- Series sections (`services/series_sections.py`): About is **prepended**
  (`**About this Article**` … `---`), Continue Reading is **appended**
  (`\n\n---\n\n**Continue Reading**` …), same shape in ES with
  `**Acerca de este artículo**` / `**Continuar leyendo**`. The last member of a series
  has no Continue block. There is **no reusable bilingual splitter** today —
  `utils/markdown.py::extract_series_header` is EN-only and `article_audio.py`
  re-implements the split with a `_CTA_HEADER` regex. `scripts/remove_series_sections.py`
  shows the tolerant forms real rows contain (`\*{2,3}`, `* * *` rules).
- `grammar_check.py` sends the **whole** content, sections included, to the LLM — a
  pre-existing inconsistency, out of scope here but worth knowing.
- `PUT /admin/dashboard/articles/{id}` only accepts `content_html`, wholesale, and
  never stamps the grammar columns. `GET .../articles/{id}/download?lang=` is the
  only raw-markdown read.

---

## 4. Design

### 4.1 Contract in one line

> The extension never sees markdown. PIC hands it **body HTML** for one language,
> the extension hands back **body HTML** plus the list of accepted suggestions, and
> PIC does the split, the conversion, the re-assembly, the stamp and the audit.

### 4.2 New PIC endpoints (dashboard router, admin magic-link auth, `app/api/dashboard.py`)

**`GET /admin/dashboard/articles/{id}/grammar-source?language=en|es`**
→ `GrammarSourceResponse`

```json
{
  "article_id": 228, "language": "en", "title": "…",
  "body_html": "<h2>…</h2><p>…</p>",
  "has_about": true, "has_continue": false,
  "fingerprint": "sha256 of the language's full content column",
  "block_count": 31
}
```

- `body_html = markdown_to_html(body)` where `(about, body, cont) = split_series_sections(content, lang)`.
- 400 when the language has no content.

**`POST /admin/dashboard/articles/{id}/grammar-apply?language=en|es`**
body `GrammarApplyRequest`:

```json
{
  "body_html": "<h2>…</h2><p>…</p>",
  "fingerprint": "…",
  "tool": "grammarly",
  "dry_run": false,
  "accepted": [{"category": "Grammar", "kind": "Add a comma", "before": "…", "after": "…"}]
}
```

→ `GrammarApplyResponse {article_id, language, changed, accepted_count, checked_at | null, diff_preview: [..] }`

Rules, in order:

1. **Fingerprint** — recompute on the current row; mismatch → **409** (someone edited
   the article in the drawer while Grammarly was running).
2. **Re-split** the current column at apply time (never trust the client's memory
   of the sections): `about + html_to_markdown(body_html) + cont`.
3. **Block-count guard** — `html_to_markdown` output paragraph count must equal the
   source's (`block_count`); otherwise 400 with a diff preview. This catches a bad
   serializer or a suggestion that merged paragraphs.
4. `dry_run=true` → return `changed` + a small unified-diff preview, write nothing.
5. `accepted == []` → **do not touch content**; stamp only. This is what makes a
   clean article a no-op instead of a normalisation churn.
6. Otherwise write the column, `sync_article_slugs` is *not* involved (title is not
   in scope), stamp `grammar_checked_{lang}_at = now(UTC)`, write one
   `GrammarCheckFix` row per accepted item (`find_text=before`, `replace_text=after`,
   `applied=True`), commit.

Audit provenance: add `grammar_check_fixes.source` (`String(20)` + `status_check`,
enum `GrammarFixSource {LLM, GRAMMARLY}`, default `LLM`, migration `0032`) so the
two passes are distinguishable in the table. Optional but cheap; without it the
Grammarly rows are indistinguishable from LLM rows. Remember
`tests/test_edu_guide_grounding.py` pins the sole Alembic head by name.

**New helper** `services/series_sections.py::split_series_sections(content, lang) -> (about, body, cont)`:
bilingual, tolerant (`\*{2,3}` bold, `---` or `* * *` rules), returns `("", content, "")`
when no markers, and re-joins to the identical string (`about + body + cont == content`
is a unit test on every fixture). Later, `article_audio.segment_article` and
`extract_series_header` can be pointed at it — not in this PR.

Tests: `tests/test_grammar_apply.py` — splitter round-trips on EN/ES/last-member/
`* * *` fixtures; source endpoint strips sections; apply re-attaches them
byte-identically; fingerprint 409; block-count 400; empty `accepted` stamps without
writing; dry-run writes nothing; `source` CHECK. Both ruff gates.

Nothing here needs `DRIVER_ALLOWED_CALLS`: the extension authenticates with the
operator's admin magic link, not the driver token.

### 4.3 Extension: new run type `grammar`

Follows the `fact_check` precedent exactly (one run type = one endpoint that
produces the input + one that receives the result), with a second site driver.

**Discovery (popup).** `GET /admin/dashboard/articles` → pending =
`has_content && !grammar_checked_en_at` ∪ `has_spanish && !grammar_checked_es_at`,
restricted to `status === 'APPROVED'` by default (toggle for drafts later). Popup row:
"Grammar: 12 pending (EN 7, ES 5)" + Start, disabled at 0. Message
`pic:get-grammar-pending`.

**Run unit** = one `(article_id, language)`. A run chains through the pending list
like fact-check batches, `MAX_GRAMMAR_ITEMS_PER_RUN = 10`, lowest article id first,
EN before ES for the same article.

**Phases** (`picExecutionState.runType === 'grammar'`):

```
fetching_source → opening_grammarly → pasting → analysing → accepting → extracting → applying → done | failed
```

`WORKER_BOUND_PHASES` gains `fetching_source`, `opening_grammarly`, `applying`;
`pasting`/`analysing`/`accepting`/`extracting` are content-script-bound and report
progress with `pic:grammarly:progress {accepted, remaining, score}` which the worker
persists (`transition` keeps `phaseChangedAt` fresh so the 6-min watchdog does not
fire mid-loop).

As built (#19): every grammar phase, `humanizing` included, is in `WORKER_BOUND_PHASES` (`GRAMMAR_PHASES` in `grammar-phases.js`). The accept and Humanizer loops run detached in the page: the worker starts them with `pic:grammarly:accept` / `pic:grammarly:humanize` and then polls `pic:grammarly:accept-status` / `pic:grammarly:humanize-status` every 3 s (`pollLoop` in `src/background/grammar-run.js`, 40-minute cap per loop). Each poll persists `accepted` / `seen` / `progress` through `transition`, and that is what keeps `phaseChangedAt` fresh; the content script still sends a best-effort `pic:grammarly:progress` during the accept loop, but the worker does not depend on it.

**State fields added**: `articleId, language, articleTitle, docUrl, fingerprint,
blockCount, accepted[], dismissed[], scoreBefore, scoreAfter, queue[], totals{items, accepted, unchanged}`.

**Tab**: `chrome.tabs.create({url: 'https://app.grammarly.com/ddocs/new', active: true})`,
wait for the URL to match `coda.grammarly.com/d/`, persist it as `docUrl`.
Resumption after worker death is *easy* here because the doc lives on Grammarly's
server: reopen `docUrl` and continue from the persisted phase. As built, the worker first re-attaches to the saved tab when its Grammarly doc id (the stable suffix after the last `_` in the doc's path segment under `/d/`, which survives the re-titling) matches `docUrl`, and keeps polling the loop still running there; it opens `docUrl` again when there is no saved tab, the tab is gone, or the tab now shows a different doc.

**Content script `src/content/grammarly/`** (classic IIFEs on `window.PIC`, same as
`claude/`; `wait-utils.js` and `dom-utils.js` are listed again in the manifest block
and reused verbatim):

- `selectors.js` — the registry from §2 (`editor`, `suggestionCard`, `suggestionCardExpanded`,
  `acceptButton`, `dismissButton`, `pillAll`, `pillGrammar`, `pillClarity`, `pillDelivery`,
  `overallScore`, `aiDetectionPromoClose`), each with `description`.
- `serializer.js` — `PIC.grammarly.readHtml()` (§2.3, strict) and `PIC.grammarly.readText()`.
- `main.js` — handlers:
  - `pic:grammarly:ping`
  - `pic:grammarly:paste {html}` → clears the editor if not empty, pastes, waits for
    `readText()` to stabilise, returns `{blockCount, textLength}`.
  - `pic:grammarly:wait-analysis` → until the score is numeric and the card count has
    been stable for `settleTime` (≈3 s), timeout 90 s. Returns `{score, counts}`.
    As built: 180 s in the content script (a 3,600-word doc took over 60 s), 240 s on the worker's message.
  - `pic:grammarly:accept {policy, dryRun}` → the loop below, streams `progress`.
    As built: it starts the loop detached and returns at once; `pic:grammarly:accept-status` reports `none` / `running` / `done` / `failed` with what has been accepted and seen so far.
  - `pic:grammarly:extract` → `{html, text, blockCount, score}`.

**Accept loop** (`pic:grammarly:accept`):

```
while cards remain and iterations < 200:
  card = first collapsed card in DOM order
  card.click(); wait until it has class *isExpanded* and an Accept button
  kind = h3 text; category = which pill's count it belongs to (or infer from icon)
  decision = policy(kind, category)      # accept | dismiss
  record {kind, category, snippet(h2), decision}
  if dryRun: dismiss? no — leave it; break after recording all kinds
  click Accept or Dismiss; wait until card count drops by 1 (timeout 10 s)
  report progress every 5 items
```

Default policy (`DEFAULT_POLICY` in `grammar-run.js`, **per language**): **accept**
`Grammar`, `Clarity` and `Delivery` (since 2026-09-27; Grammar only before
that), **except** kinds in a deny list: `Check wording` for both languages, plus
`Rewrite the sentence`, `Fix capitalization` and `Correct the mistake` for ES,
where the dry run of article 245 flagged proper nouns (*Ruta de la Plata*,
*Panamá la Vieja*) as errors (#22). Clarity and Delivery were human passes (#24)
until PIC's Sonnet meaning check (#518, recalibrated in PIC #544) could revert
the rewrites that change a claim. Denied cards are left in place, never
dismissed. `settings.grammarPolicy` overrides per language (`{en, es}`) or, in
the legacy flat shape, for both.

Before pasting, the worker refuses a body carrying `h1` or `h4`–`h6`
(`grammar-guards.js`, #28): Grammarly has three heading levels and reads an h4
back as h3, which the serializer cannot detect. The item ends `refused` with the
reason in `itemResults`; no doc is opened and nothing is stamped.

Each `itemResults` entry also carries its audit (#23): `acceptedItems`
(kind + before/after), `seenItems` (every card the loop looked at with its
decision — `denied` / `stuck` / `no-accept-button` / `seen` on a dry run /
`accepted`, bounded to 400 entries, snippets trimmed to 160 chars), and the
#518 meaning-check counts (`meaningChecked`, `revertedCount`, `reviewCount`).
**Humanizer pass (#21, 2026-09-22).** Each item is three content-script loops:
Grammar-only accept → `pic:grammarly:humanize` (adopt `policy.humanizer.voice`,
default "The Everyday Voice", walk every block rewrite) → Grammar-only accept
again, because a rewrite surfaces new Grammar underlines. `state.stage`
(`grammar1` / `humanize` / `grammar2`) is persisted so a restarted worker
resumes the loop it was polling; accepted items accumulate in
`state.acceptedSoFar` and reach `grammar-apply` as `category: "Humanizer",
kind: <card title>` with the whole block as before/after. Bold / italic runs
the rewrite rewords are allowed to go (operator decision); a link whose text
would not survive verbatim makes the content script **dismiss** that card
(`link-at-risk`). A dry run records each card's title + proposed text, dismisses
it, and skips pass 2. Recon: `docs/grammarly-recon.md` §4. The Humanizer's
editor decorations render **only while its panel is the visible one**, and a
hidden voice card still takes a click — so `humanize` first brings the panel
to the front, and an empty annotation list is re-read for a few seconds (with
the panel re-shown if it slipped behind) before the walk is declared drained
(2026-09-22, article 246 ES stopped after 1–2 rewrites).

**Score gate.** `policy.minScoreToStamp` (default 97, 0 disables): when
Grammarly's final overall score is below it the item is applied with
`stamp: false` — the corrections are written, the audit rows recorded, but
`grammar_checked_<lang>_at` stays unset and the article returns in the next
run (`applied_unstamped` / `unstamped` in the popup). PIC PR #532 is the
backend half.

The popup renders each item as an expandable `<details>` block
(`src/popup/grammar-audit.js` holds the pure formatting helpers) and the
"Copy state" button puts the whole run state on the clipboard as JSON. Never touch the *Strengthen writing* tab. `before/after`
for the audit row: capture `readText()` before and after each accept and record the
single differing block (cheap and exact; the card's own snippet is elided with `…`).

**Dry run** (default ON, as for the other run types): paste, analyse, *record* every
suggestion kind and count, extract, call `grammar-apply` with `dry_run=true` and
`accepted=[]`. The apply response's `changed` must be `false` — that is the
serializer's acceptance test, run on real articles before any Accept is ever
clicked. Show the result in the popup (`describeUploadResult` branch).

**Worker (`run.js`)**: `executeRun` and `finishRun` branch on `runType === 'grammar'`;
`waitForContentScript` and `ensureTab` take the ping message + URL prefix + script
list as parameters instead of hard-coding `pic:claude:*` (small refactor, keeps the
two site drivers symmetric). `GRAMMARLY_CONTENT_SCRIPTS` mirrors the manifest list.
`pic-api.js` gains `getArticles`, `getGrammarSource`, `applyGrammar`.

**Manifest**: `host_permissions` += `https://app.grammarly.com/*`,
`https://coda.grammarly.com/*`; new `content_scripts` block for
`https://coda.grammarly.com/d/*` with the ordered list
`[grammarly/selectors.js, claude/wait-utils.js, claude/dom-utils.js, grammarly/serializer.js, grammarly/main.js]`.
(Consider moving `wait-utils.js` / `dom-utils.js` to `src/content/shared/` in the
same PR since they are no longer claude-specific.)

### 4.4 Failure handling

| Situation | Behaviour |
|---|---|
| Serializer meets an unknown node | run **failed**, `errorDetail` = outerHTML; nothing written. |
| `grammar-apply` 409 (fingerprint) | item **skipped**, logged, chain continues. |
| `grammar-apply` 400 (block count) | item failed, diff preview persisted for the popup; chain continues. |
| Accept did not reduce the card count in 10 s | dismiss that card instead, record `stuck`, continue; > 3 stuck → fail the item. As built: the card is **skipped**, not dismissed (recorded `stuck`, left in place); the fourth stuck card fails the loop, which fails the whole run (see the next row). |
| Analysis never settles (90 s) | fail the item (Grammarly outage or language not supported). As built: the timeout is 180 s and it fails the **whole run**, not the item: apart from the pre-paste heading refusal (§4.3), only `ApiError` 409 / 400 from `grammar-apply` are recorded per item (`skipped` / `refused`), and content-script errors are not ApiErrors, so they reach `failRun`. |
| Worker dies mid-loop | watchdog sees a content-bound phase with fresh `progress`; if `phaseChangedAt` is stale > 6 min, reopen `docUrl`, re-extract, **apply with whatever was accepted so far** (the doc is the source of truth), mark the item `partial`. As built: on its next 1-minute tick the watchdog resumes an orphaned grammar run (`resumeGrammarRun`) without waiting for the 6-minute staleness. From `accepting` / `humanizing` / `extracting` / `applying` with a saved `docUrl` it re-attaches by doc id (or reopens `docUrl`), keeps polling or restarts the current stage, then extracts and applies everything accepted so far; a successfully applied item carries `resumed: true` (the 409 / 400 results don't). The watchdog also runs whenever the popup asks for state. From an earlier phase the item restarts from `fetching_source`. |
| Grammarly logged out | `coda.grammarly.com` redirects to `auth.grammarly.com` — detect the host, fail with "sign in to Grammarly in this Chrome profile". |

---

## 5. Milestones / PR plan

1. **PIC PR 1 — splitter + endpoints** (`panama-in-context`): `split_series_sections`,
   `grammar-source`, `grammar-apply`, `GrammarFixSource` + migration `0032`, tests,
   `docs/pic-api.md` entries here. Deployable on its own; harmless without a caller.
   → operator runs `alembic upgrade head` on the droplet (deploys do not migrate).
2. **Ext PR 2 — recon + serializer, dry-run only**: manifest, `src/content/grammarly/`,
   `docs/grammarly-recon.md` (this file's §2 promoted to the recon format of
   `claude-ai-recon.md`, updated with §2.4 answers), run type wired through
   `executeRun`/`finishRun`/popup **with the accept step stubbed**. Exit criterion:
   dry run on ≥ 5 real articles per language returns `changed: false` from
   `grammar-apply`.
3. **Ext PR 3 — accept loop + chaining + audit**: policy, progress, recovery table
   above, `describeUploadResult`, popup counts. Exit criterion: one EN and one ES
   article proofread end-to-end, `GrammarCheckFix` rows present with
   `source='GRAMMARLY'`, the admin grid pills turn green, series sections
   byte-identical (`git diff`-style check via the download endpoint before/after).
4. **Backlog drain**: dry run OFF, chain through the pending list in batches of 10,
   spot-check the first few diffs in the grid's grammar modal (it already renders
   `GrammarCheckFix` rows).
5. **Later / optional**: delete the Grammarly doc after apply (§2.4.5); title +
   excerpt proofreading (send them as an `h1` + first paragraph and peel them off in
   `grammar-apply`); route the `GRAMMAR_CHECK_*` weekly-plan kinds at this flow
   (needs a driver-side trigger for an extension, so probably never — the popup
   backlog row is the equivalent).

---

## 6. Decisions taken (and why), for the implementer

- **Endpoint, not a JS port of the converter.** The converter is python-markdown +
  nh3 + markdownify; a JS re-implementation would drift and the drawer would then
  disagree with the extension. The endpoint also puts the section split and the
  stamp behind one commit.
- **Body only, sections re-attached server-side at apply time.** The client never
  holds the About/Continue text, so it cannot corrupt it, and a concurrent
  regeneration of the sections is caught by the fingerprint.
- **DOM serializer, not clipboard.** Synthetic `copy` yields nothing and
  `navigator.clipboard.read()` needs a permission prompt; the `kr-*` classes are a
  stable, semantic read.
- **Empty accept list ⇒ stamp only.** Avoids rewriting a clean article through the
  normalising round trip.
- **One `(article, language)` per run item**, chained — same shape and same
  backstops as the fact-check drain, so the watchdog/orphan logic generalises.
- **Dry run must pass on real articles before Accept exists** — the only real risk in
  this whole flow is a lossy read-back, and that is testable without touching data.
