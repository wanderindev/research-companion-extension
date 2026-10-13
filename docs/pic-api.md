# PIC admin API reference (research pipeline)

Source of truth: `panama-in-context` repo (`backend/app/api/dashboard.py`, `backend/app/api/auth.py`, `frontend/src/services/admin.js`). Verified against the code 2026-07-12; line refs are from that date.

Base URL: `https://panamaincontext.com/api/v1`. All research endpoints live under `/admin/dashboard` and require `Authorization: Bearer <token>` (router-level dependency, `dashboard.py:87`).

## Auth

- Magic link flow: `POST /auth/admin/request-access {email}` → email contains `https://panamaincontext.com/admin#token=<token>`.
- Token: opaque `secrets.token_urlsafe(32)`, **7-day** expiry (`ADMIN_LINK_VALIDITY`), revoked by `POST /auth/admin/logout`.
- The admin SPA stores it in `sessionStorage` as `adminToken` (plus `adminEmail`) — `frontend/src/contexts/AdminAuthProvider.jsx`. This is what the extension's token-capture content script reads.
- Validate anytime: `POST /auth/verify-token {token}` → `{valid, action, admin_email, expires_at}`; require `action == "ADMIN_ACCESS"`.
- Failures surface as `401 "Invalid or expired admin token"`.
- No rate limiting on these endpoints; auth is header-based so CORS/CSRF are non-issues for service-worker fetches with host_permissions.

## Endpoints used by the extension

### 1. List suggestions available for research

`GET /admin/dashboard/suggestions/available-for-research`

Returns `SuggestionListItem[]`: `{id, title, title_es, taxonomy_name, category_id, category_name, status, has_research, articles_status, created_at}`. Semantics: `status == APPROVED` and no row in `research` for the suggestion. Admin UI labels options as `"{title} ({category_name})"`.

### 2. Generate research prompt

`POST /admin/dashboard/research/generate-prompt` — JSON `{"suggestion_id": <int>}`

→ `{suggestion_id, suggestion_title, prompt_text}`. Nothing is persisted server-side; `prompt_text` is the full deep-research prompt (Sonnet-tailored template: REF tag, series/category context, main topic, sub-topics, POV, requirements incl. `## References` section, 5000–8000 words).

Errors: 404 unknown id; 400 if suggestion not APPROVED or research already exists.

Heads-up: this endpoint calls Claude server-side (max_tokens 14000) — allow a generous fetch timeout (~2 min).

### 3. Upload research

`POST /admin/dashboard/research/upload` — `multipart/form-data`: `file` (.md, UTF-8, ≤5 MB), `suggestion_id` (form field). Optional query `?force=true` to overwrite an APPROVED research.

Do **not** set Content-Type manually (let fetch set the multipart boundary). Build the file in-memory: `new File([markdown], "suggestion_<id>_research.md", {type: "text/markdown"})`.

→ `{suggestion_id, suggestion_title, research_id, word_count, status, references_generated}`. New/updated row lands with `status = "PENDING"` (approval stays manual in the admin panel).

Server-side validation (`services/research_common.py`):
- word count ≥ 4000;
- references heading present (`Sources|References|Bibliography|Works Cited|Citations`) — if missing, the server auto-generates one via Haiku (`references_generated: true`);
- ≥ 2 of the suggestion's sub-topics substantively covered (Haiku check).

Errors: `400` with structured `detail: {message, checks, word_count}` (parse it — the admin UI does); `409` if research exists and is APPROVED and `force` not set; `413` >5 MB; `404` unknown suggestion.

## Deep-research fact-check loop (epic #373 / #377; endpoints from PR #383)

The web-search fact-check tier marks unresolvable claims `NEEDS_DEEP_RESEARCH`;
the extension drives their verification exactly like a research run.

### 4. Pending count (popup badge)

`GET /admin/dashboard/fact-check/summary` → `[{subject_type, subject_id, counts}]`.
Sum `counts.NEEDS_DEEP_RESEARCH` across items for the total awaiting deep research.

### 5. Generate fact-check prompt

`POST /admin/dashboard/fact-check/deep-research/generate-prompt` — JSON `{}`
(optional `{subject_type, subject_id}` scope) →
`{batch_id, claim_ids, claim_count, pending_total, prompt_text}`.
Batches ≤25 claims (`DEEP_RESEARCH_BATCH_LIMIT`); stateless; **404 when nothing is pending**. Loop until
`pending_total == claim_count` processed.

### 6. Upload verdict document

`POST /admin/dashboard/fact-check/deep-research/verdicts` — JSON
`{content: <verdict markdown>, claim_ids: <echoed from the prompt response>}` →
`{written, skipped: [{claim_id, reason}], missing_claim_ids, kb_upserts}`.
Validation mirrors the /fact-check-process skill: off-vocabulary or uncited
VERIFIED/INACCURATE/DISPUTED verdicts are skipped; rows no longer pending are
skipped (stale-safe); out-of-batch verdicts skipped. 400 if the document has
no `VERDICT:` lines at all.

## Nearby endpoints (later processes / completeness)

- Research grid: `GET /admin/dashboard/research`; download: `GET /admin/dashboard/research/{id}/download`.
- Status change: `PATCH /admin/dashboard/{entity}/{entity_id}/status` body `{status: PENDING|APPROVED|REJECTED}`, entity ∈ suggestions|research|articles.
- Edu mirror of the whole pipeline: same shapes under `/admin/dashboard/edu/...` (`edu/suggestions/available-for-research`, `edu/research/generate-prompt`, `edu/research/upload`).

## Process 2 — Grammarly proofread (panama-in-context PR #517)

The extension never sees markdown and never holds the About / Continue Reading
series sections: PIC hands it body HTML, receives body HTML back, and does the
split, the conversion, the re-assembly, the stamp and the audit rows.

### 1. Pending work (popup badge)

`GET /admin/dashboard/articles` → `[{id, title, title_es, status, has_content, has_spanish,
grammar_checked_en_at, grammar_checked_es_at, …}]`. Pending = `has_content && !grammar_checked_en_at`
plus `has_spanish && !grammar_checked_es_at`, APPROVED only by default.

### 2. Fetch the body

`GET /admin/dashboard/articles/{id}/grammar-source?language=en|es` →
`{article_id, language, title, body_html, has_about, has_continue, fingerprint, block_count}`.
400 when that language has no content. `fingerprint` is the SHA-256 of the full stored column.

### 3. Apply the corrected body

`POST /admin/dashboard/articles/{id}/grammar-apply?language=en|es` — JSON
`{body_html, fingerprint, tool: "grammarly", dry_run, accepted: [{category, kind, before, after}], stamp, score}` →
`{article_id, language, changed, written, accepted_count, block_count, checked_at, diff_preview, stamped, meaning_checked, reverted_count, review_count}`.

Request defaults: `tool` `"grammarly"` (the only allowed value), `dry_run` `false`, `accepted` `[]`, `stamp` `true`, `score` `null` (Grammarly's final overall score, 0 to 100, recorded in the server log only). In `accepted`, `category` and `kind` are optional; `before` and `after` are required. The extension sends `stamp: false` when the final score is below `policy.minScoreToStamp`.

- **409** fingerprint mismatch (article edited meanwhile) — skip the item, re-fetch next run.
- **400** paragraph count changed (`detail: {message, diff_preview}`) — a lossy read-back or a merged paragraph; never retried automatically. Also 400 when `body_html` converts to empty markdown.
- `dry_run: true` writes nothing and stamps nothing (`written: false`, `checked_at: null`, `stamped: false`); `changed` must be `false` when the source HTML is posted back untouched (serializer acceptance test).
- `accepted: []` does not rewrite the content; it only sets `grammar_checked_<lang>_at` (when `stamp` is true).
- otherwise PIC runs the meaning check (PIC #518): Sonnet reviews each changed paragraph, reverts edits that change meaning (`reverted_count`) and files the ones it cannot vouch for as `GrammarReviewDiff` rows for a human (`review_count`; those are written but flagged). The body is then written between the untouched sections and one `grammar_check_fixes` row per accepted item is recorded with `source = GRAMMARLY` (reverted ones with `applied = false`). `meaning_checked` is true when Sonnet was actually called.
- `stamp: false` still writes the body and the audit rows but leaves `grammar_checked_<lang>_at` unset, so the article stays in the queue; `stamped` echoes `stamp`, and `checked_at` is then `null`.
