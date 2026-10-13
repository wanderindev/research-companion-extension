// PIC admin API client. Endpoint contracts: docs/pic-api.md (source of truth
// is the panama-in-context repo). All calls run in the service worker, where
// host_permissions exempt us from page CORS; auth is a Bearer header.

const PROD_API_BASE = 'https://panamaincontext.com/api/v1';
const DEV_API_BASE = 'http://localhost:8000/api/v1';

// The prompt-generation endpoint calls Claude server-side; give it headroom.
const GENERATE_PROMPT_TIMEOUT_MS = 180_000;

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

/** The admin SPA origin the token was captured on determines the API base. */
export function apiBaseForOrigin(origin) {
  return origin.startsWith('http://localhost') ? DEV_API_BASE : PROD_API_BASE;
}

async function request(auth, path, { method = 'GET', body, timeoutMs } = {}) {
  const headers = { Authorization: `Bearer ${auth.token}` };
  let fetchBody;
  if (body instanceof FormData) {
    fetchBody = body; // browser sets the multipart boundary
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  const response = await fetch(`${auth.apiBase}${path}`, {
    method,
    headers,
    body: fetchBody,
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (!response.ok) {
    let detail = null;
    try {
      detail = (await response.json()).detail ?? null;
    } catch {
      // non-JSON error body
    }
    const summary = typeof detail === 'string' ? detail : detail?.message;
    throw new ApiError(
      summary || `${method} ${path} failed with ${response.status}`,
      response.status,
      detail,
    );
  }
  return response.json();
}

/** No auth required; used to validate a freshly captured token. */
export async function verifyToken(apiBase, token) {
  const response = await fetch(`${apiBase}/auth/verify-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    throw new ApiError(`Token verification failed with ${response.status}`, response.status);
  }
  return response.json(); // {valid, action, admin_email, expires_at, ...}
}

/** APPROVED suggestions with no research row yet. */
export function getSuggestionsForResearch(auth) {
  return request(auth, '/admin/dashboard/suggestions/available-for-research');
}

/** @returns {Promise<{suggestion_id, suggestion_title, prompt_text}>} */
export function generateResearchPrompt(auth, suggestionId) {
  return request(auth, '/admin/dashboard/research/generate-prompt', {
    method: 'POST',
    body: { suggestion_id: suggestionId },
    timeoutMs: GENERATE_PROMPT_TIMEOUT_MS,
  });
}

/**
 * Upload research markdown built in memory — no filesystem involved.
 * 400 => validation failure (detail: {message, checks, word_count});
 * 409 => research exists and is APPROVED (never auto-force; surface it).
 */
export function uploadResearch(auth, suggestionId, markdown, { force = false } = {}) {
  const form = new FormData();
  form.append(
    'file',
    new File([markdown], `suggestion_${suggestionId}_research.md`, { type: 'text/markdown' }),
  );
  form.append('suggestion_id', String(suggestionId));
  const query = force ? '?force=true' : '';
  return request(auth, `/admin/dashboard/research/upload${query}`, {
    method: 'POST',
    body: form,
  });
}

// --- Deep-research fact-check loop (panama-in-context PR #383) ---

/**
 * Per-subject verdict counts; used to derive how many claims are awaiting
 * deep research. @returns {Promise<Array<{subject_type, subject_id, counts}>>}
 */
export function getFactCheckSummary(auth) {
  return request(auth, '/admin/dashboard/fact-check/summary');
}

/**
 * Compile pending NEEDS_DEEP_RESEARCH claims into one prompt batch (≤25, PIC's DEEP_RESEARCH_BATCH_LIMIT).
 * 404 => nothing pending.
 * @returns {Promise<{batch_id, claim_ids, claim_count, pending_total, prompt_text}>}
 */
export function generateFactCheckPrompt(auth) {
  return request(auth, '/admin/dashboard/fact-check/deep-research/generate-prompt', {
    method: 'POST',
    body: {},
  });
}

/**
 * Write a deep-research verdict document back. claim_ids bounds the batch:
 * out-of-batch verdicts are skipped, unanswered ids come back as missing.
 * @returns {Promise<{written, skipped, missing_claim_ids, kb_upserts}>}
 */
export function uploadFactCheckVerdicts(auth, markdown, claimIds) {
  return request(auth, '/admin/dashboard/fact-check/deep-research/verdicts', {
    method: 'POST',
    body: { content: markdown, claim_ids: claimIds },
  });
}

// --- Grammarly proofread flow (panama-in-context PR #517) ---

/**
 * Every article with per-language flags and the grammar stamps
 * (`grammar_checked_en_at` / `_es_at`); no filters, no pagination.
 */
export function getArticles(auth) {
  return request(auth, '/admin/dashboard/articles');
}

/**
 * One language's article BODY as HTML, series sections stripped server-side.
 * @returns {Promise<{article_id, language, title, body_html, has_about, has_continue, fingerprint, block_count}>}
 */
export function getGrammarSource(auth, articleId, language) {
  return request(auth, `/admin/dashboard/articles/${articleId}/grammar-source?language=${language}`);
}

/**
 * Post the corrected body HTML back. 409 => article changed meanwhile;
 * 400 => paragraph count changed (detail: {message, diff_preview}).
 * dry_run reports only; empty `accepted` stamps without rewriting.
 * @returns {Promise<{changed, written, accepted_count, block_count, checked_at, diff_preview}>}
 */
export function applyGrammar(auth, articleId, language, body) {
  return request(auth, `/admin/dashboard/articles/${articleId}/grammar-apply?language=${language}`, {
    method: 'POST',
    body: { tool: 'grammarly', ...body },
  });
}
