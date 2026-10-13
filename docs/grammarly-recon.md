# coda.grammarly.com — live recon (2026-09-20)

Documentation of `src/content/grammarly/selectors.js` and `serializer.js`.
Everything below was exercised on real docs with claude-in-chrome, not read
from docs. Grammarly's hashed classes churn on their deploys; only
`data-testid`, `role`, `aria-*`, button labels and the semantic `kr-*` editor
classes are anchored on.

## 1. Page shape

| Thing | Finding |
|---|---|
| New doc | `GET https://app.grammarly.com/ddocs/new` redirects (~3 s) to `https://coda.grammarly.com/d/Untitled-doc_<id>/Untitled-page_<id>#_<cursor>`; the URL later re-titles itself from the first heading. A signed-out profile lands on `auth.grammarly.com`. |
| Editor | Exactly one `div[contenteditable="true"][data-editable-id="root"][role="textbox"]` (Slate). No iframes, no shadow DOM. |
| Side panel | **Stateful** — it reopens on the last tool used (Humanizer, AI Chat, …). The right rail is `button[aria-label="Grammarly"]`, `…="Humanizer"`, etc.; the Grammarly panel has `button[role="tab"]` **Proofread** / **Strengthen writing**. Always click the rail button and the Proofread tab before reading cards. |
| Category pills | `button[aria-pressed]` whose text is `All 37`, `Grammar 11`, `Clarity 23`, `Delivery 3`. Clicking one filters the card list (verified: Grammar → 11 cards, Delivery → 3). |
| Suggestion cards | `[data-testid="feed-card"]` (also `data-card-type="feed"`) inside `[data-testid="scroll-container"]`. Was `data-testid="suggestion-card"` until Grammarly renamed it (seen 2026-10-13: pills showed counts but 0 cards matched, so `wait-analysis` never settled and the run sat idle after the paste). Collapsed cards have `role="button"`; the expanded one gains a class containing `isExpanded` and exposes real `<button>`s **Accept** / **Dismiss**. `h2` = "Suggestion for <snippet>", `h3` = kind ("Add a comma", "Improve wording", "Rewrite the sentence", "Correct article usage", "Want to sound more confident?" (Delivery)). `[data-testid="suggestion-icon"]` is an inline-SVG `<img>` whose fill colour encodes the category — not used, the pills are the reliable signal. |
| Score | "<n> Overall score" in the header (`--` while analysing). **It appears before the panel finishes loading**: on a fresh doc the panel is a skeleton for ~15 s after the paste — no `button[role=tab]`, no pills, no cards — while the score is already numeric. Wait for the pills + cards, not the score. The same skeleton comes back after **every Accept** on a long doc (re-analysis), and a 3,600-word doc took >60 s to analyse initially. Pill counts cap at `99+`. **Analysis does not run while the tab is hidden** (`document.visibilityState === 'hidden'`) — keep the Grammarly tab in the foreground. |
| Language | Auto-detected per doc; pasting Spanish is proofread in Spanish with no setting. The Spanish proofreader flags Panamanian proper nouns: article 245 ES dry run (2026-09-20) produced Grammar "Fix capitalization" on "ruta" / "plata" (Ruta de la Plata) and "Correct the mistake" on "la Vieja" (Panamá la Vieja). Both kinds are on the ES deny list (#22). |
| Noise | A dismissible "Try our AI detection" promo at the bottom of the panel. Harmless. |

## 2. Verified interactions

| Action | How | Result |
|---|---|---|
| Insert rich text | focus editor, collapse selection to end, `dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt}))` with `dt.setData('text/html', html)` | h1–h3, `strong`, `em`, `a`, `ul/ol/li`, `blockquote`, `p` rendered. **h4 is downgraded to h3** (Grammarly has three heading levels). |
| Expand a card | `card.click()` | Accept / Dismiss appear. |
| Accept | click the `Accept` button in the expanded card | editor text changed, card count −1. |
| Copy out via `copy` event / `navigator.clipboard.read()` | — | does not work / needs a permission prompt. **Read the DOM instead.** |

## 3. Editor DOM → HTML (`serializer.js`)

Top-level children of the editor are the blocks:

| Block | Tag + classes |
|---|---|
| Heading | `h1.kr-h1`, `h2.kr-h2`, `h3.kr-h3` |
| Paragraph | `div.kr-paragraph` |
| Bullet / numbered item | `div.kr-ulist.kr-listitem` / `div.kr-olist.kr-listitem` (one block per item; nested items differ only by `padding-left` > 28px) |
| Quote | `blockquote` |
| Horizontal rule | `div.kr-object-e` (unsupported — never in article bodies) |
| Code block | bare `div.kr-line-set-width` without `kr-paragraph` (unsupported) |
| Inline | `span.kr-span` with `kr-bold` / `kr-italic` / `kr-mono` / `kr-underline` / `kr-line-through`; link = `a[href]` inside a `var[contenteditable=false]`, followed by `span.kr-hidden-child` holding a U+2060 word joiner |
| Skip | anything inside `[data-editable-ignore-node]` (block gutter widgets), `.kr-hidden-child` |

The serializer is strict: an unrecognised block or inline node throws with its
outerHTML. Production article bodies (surveyed 2026-09-20, 113 articles) use
h2/h3 (one h1), paragraphs, bold, italics and links only.

## 4. Humanizer panel — live recon (2026-09-22, pic-extension #21)

Exercised on three scratch docs (EN with h2/paragraph/bold/italic/link/ul/blockquote,
ES with two paragraphs, and a two-sentence EN note). Nothing here is read from docs.

| Thing | Finding |
|---|---|
| Open | Rail `button[aria-label="Humanizer"]`. Clicking `button[aria-label="Grammarly"]` switches back; the hidden panel's Proofread tab is still in the DOM (`getClientRects().length === 0`), so `prepare()` tests visibility, not presence — presence alone failed pass 2 live with `Category pill "All" not found` (2026-09-22). Both side panels stay in the DOM (`h1` "Grammarly" and `h1` "Humanizer"); the Grammarly one is hidden, so selectors scoped to `[data-testid="feed-card"]` still match the *proofread* cards, never Humanizer's. |
| Voice list | "Use my voice / Create a voice" then "Adopt a voice": `button[aria-pressed]` cards whose text starts with the voice name — **The Naturalist** (New), **The Precisionist**, **The Everyday Voice**, **The Executive**, **The Scholar** — plus a `[placeholder="Describe a voice"]` textarea. Same `button[aria-pressed]` shape as the proofread pills; `pill()`'s `^Grammar\b` regex keeps them apart. |
| Analysis signal | Clicking a voice sets it `aria-pressed="true"` **and `disabled`** immediately. Decorations stream into the editor over the next seconds (a 3-block ES doc: 2 s; a 6-block EN doc: 6 s), and the **count** appears as the card's last text line (`The Everyday Voice\n…\n5`) only when analysis is *done*. There is no spinner, `aria-busy` or progress element. **"Analysing" and "finished with nothing left" look identical on the button** (pressed, disabled, no count) — the count is the done signal; "no suggestions at all" has to be inferred from a timeout with zero decorations. Even a clean two-sentence note got one suggestion ("Combine for smoother flow"), so zero is rare. |
| Decorations | One per block with a suggestion, keyed by a suggestion id: `[data-coda-ui-id="ai-editor-text-decoration#humanizer-vbar_<id>"]` is the margin annotation (a `button` whose text is the rewrite title, e.g. "Shorten sentences and use simpler words"; **titles are English even for Spanish text**), `…#humanizer-highlight_<id>` the highlight, and `…#humanizer-vbar_card_<id>` the open card. The vbar's `getBoundingClientRect().y` matches its block's top within ~6 px, which is how a suggestion maps to an editor block index. |
| Card | `[data-testid="card-content"]`: first line = title, then the **whole rewritten block** with per-change `[data-testid="revertible-rewrite-diff"]` spans (`role=button`, `aria-label` "Undo delete, <old>, insert, <new>, …"); `innerText` interleaves deleted and inserted runs, so read the *editor block* before/after instead of the card for the audit diff. Buttons: **Accept**, **Dismiss**, "Copy to clipboard". The first card **auto-opens** when analysis finishes and the next one auto-opens after an Accept; after a Dismiss nothing opens. |
| Opening a card by hand | A bare `button.click()` on the vbar does **not** open it; a pointer sequence (`pointerover mouseover mousemove pointerdown mousedown pointerup mouseup click` with client coords) opens it in ~0.5 s. `Accept` / `Dismiss` do respond to plain `.click()`. |
| Accept | Replaces the block text in place (260 ms on the second doc; the very first accept on a fresh doc took >20 s while the proofread re-analysed). **Block count never changed** across 3 accepts on a paragraph, a list item and a blockquote. Counter decrements; the proofread panel re-analyses (score spinner) and can surface **new Grammar suggestions** on the rewritten text. |
| Dismiss | Instant, text untouched, counter decrements, decoration removed. |
| No-op cards | A card titled **"Keep as is; already clear"** proposes the block unchanged (seen 2026-09-22, 8 on one ES article). Accepting it changes no text; the walk dismisses it (`no-change`) instead of waiting for a change. |
| What gets a suggestion | Paragraphs, **each list item separately**, blockquotes. **Headings got none** in three docs. |
| Inline formatting | **Not guaranteed.** Accepting "Simplify language and shorten sentences" on the formatted paragraph kept `<em>Lima</em>` and the `<a>` link (text unchanged) but **dropped `<strong>Portobelo</strong>`** — the rewrite moved the word into "the Portobelo fairs" and the run was lost. A run survives when its text survives verbatim; a run the rewrite rewords is gone. |
| Spanish | Works with no setting: the ES doc got 2 rewrites in Spanish ("…que muchas veces recibían poco pago…"), titles in English. |
| Rewrite register | Everyday Voice = "simplify / shorten / make direct": splits long sentences, swaps "with considerable reluctance" → "so reluctantly", "obliged to contribute" → "had to provide", "engineers who drew the plans had concentrated on" → "engineers focused mainly on" (drops the relative clause). Meaning mostly kept, detail sometimes shed — exactly what the #518 Sonnet gate exists to judge. |
| Drift 2026-10-13 | Seen on article "Murallas y Sociedad Panameña" (ES, 48 blocks): (1) suggestion ids are **UUIDs** now (`vbar_<uuid>` / `vbar_card_<uuid>`, same uuid), not digits. (2) A **"Strong resemblance to AI text"** annotation opens an AI-detector notice card with only **Launch AI Detector** / **Dismiss**, no Accept; the walk crashed on it (`null.click()`) until it learned to dismiss it (`no-accept-button`). (3) A replace is **one** `revertible-rewrite-diff` span holding a struck-through `[class*="_delete_"]` run next to an `_insert_` run, so `proposedText` drops the `_delete_` runs. (4) After Accept the card closes **before** the block re-renders; the walk waits up to 5 s for the text before calling it a no-op. (5) After **Dismiss** the next card now auto-opens too. |
| Noise | "Great job / There are no more suggestions" (`aria-live=polite`) belongs to the **Grammarly** panel, not the Humanizer. |

Side effects on the account: three new scratch docs ("Walls of Panama City",
"Portobelo Fairs History", "Ruta de la Plata Panameña") plus one untitled.
