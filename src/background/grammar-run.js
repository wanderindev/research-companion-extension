// Grammar-check run type (process 2): drive Grammarly's web editor for every
// (article, language) still missing its grammar_checked_*_at stamp. One
// item at a time, chained like the fact-check drain. The extension never
// sees markdown: PIC hands it body HTML (grammar-source) and receives body
// HTML back (grammar-apply), which re-attaches the series sections, checks
// the fingerprint / paragraph count, stamps and records the audit rows.
//
// Worker-death defense: the accept loop runs detached in the content script
// and the worker POLLS it (accept-status) instead of awaiting one long
// chrome.tabs.sendMessage — a restarted worker re-attaches to the same tab
// (matched by doc id, since Grammarly re-titles the URL) and keeps polling.
// Only if the page itself is gone does the item fall back to reopening
// state.docUrl, reading the document back and applying what was accepted.

import { findRefusedHeadings, headingRefusalReason } from './grammar-guards.js';
import { ApiError, applyGrammar, getArticles, getGrammarSource } from './pic-api.js';
import {
  claimWorker,
  clearRunAlarms,
  failRun,
  releaseWorker,
  transition,
  waitForContentScript,
} from './run.js';
import { getExecutionState, getSettings, patchExecutionState } from './state.js';

export const MAX_GRAMMAR_ITEMS_PER_RUN = 10;

// Phases from which an orphaned item can be recovered from the saved doc.
const RESUMABLE_FROM_DOC = ['accepting', 'humanizing', 'extracting', 'applying'];

export const GRAMMARLY_CONTENT_SCRIPTS = [
  'src/content/grammarly/selectors.js',
  'src/content/claude/wait-utils.js',
  'src/content/claude/dom-utils.js',
  'src/content/grammarly/serializer.js',
  'src/content/grammarly/main.js',
];

const NEW_DOC_URL = 'https://app.grammarly.com/ddocs/new';
const DOC_URL_PREFIX = 'https://coda.grammarly.com/d/';

// Accepted categories: Grammar, Clarity and Delivery (2026-09-27). Clarity and
// Delivery were held back because the first live run (article 245 EN,
// 2026-09-20) accepted 18 Clarity rewrites that flattened the voice and changed
// meaning ("would concentrate" -> "concentrated"). Two things changed that call:
// PIC's grammar-apply now runs a Sonnet meaning check on every changed
// paragraph (#518) and reverts claim changes before writing, recalibrated in
// PIC #544 so it stops reverting mere tightening; and with Grammar alone most
// articles never reached the score bar below. The meaning check is the safety
// net, so a run's `applied = false` fixes and review diffs are what to read
// after the first few articles with this policy.
//
// Still denied:
// - "Check wording" (both languages) swaps a word for the one Grammarly
//   expects and can invert a deliberate turn of phrase (seen live: "got
//   assumptions" -> "got fortifications", the article's own punchline).
// - "Rewrite the sentence" (ES only, for now): restructures a whole sentence,
//   and Grammarly's Spanish model is the less reliable one. EN accepts it; if
//   one ever merges paragraphs, grammar-apply refuses the paragraph-count
//   change and nothing is written.
// - "Fix capitalization" / "Correct the mistake" (ES): Grammarly's Spanish
//   proofreader does not know Panamanian proper nouns. The dry run of article
//   245 ES (2026-09-20) flagged "ruta" / "plata" (Ruta de la Plata) and "la
//   Vieja" (Panamá la Vieja), false positives a live run would have accepted
//   (pic-extension #22).
//
// Known gap: the link guard (dismiss a rewrite that would drop a link's text)
// covers Humanizer cards only, not Clarity/Delivery cards in the accept loop.
// No pending article body carries a link today (checked 2026-09-27); add the
// guard to acceptCategory before that changes.
const SHARED_DENY_KINDS = ['Check wording'];
const ACCEPT_CATEGORIES = ['Grammar', 'Clarity', 'Delivery'];

// Humanizer (#21): after the Grammar-only pass, adopt a voice and accept the
// per-block rewrites, then run the Grammar pass again because a rewrite
// surfaces new Grammar underlines (seen live). Bold / italic runs the rewrite
// rewords are allowed to go (operator decision 2026-09-22); a link whose text
// would not survive verbatim makes the content script dismiss that card.
const DEFAULT_HUMANIZER = { enabled: true, voice: 'The Everyday Voice' };

// Grammarly's final overall score must reach this for the language to be
// stamped grammar-checked. Below it the corrections are still written
// (grammar-apply `stamp: false`) but the article stays in the queue for the
// next run (operator decision 2026-09-22: "96 or less → save, don't mark
// done"). 0 disables the gate. Note the consequence: an article that never
// reaches the bar is re-run every time until a human stamps it.
const DEFAULT_MIN_SCORE_TO_STAMP = 97;

export const DEFAULT_POLICY = {
  en: {
    acceptCategories: [...ACCEPT_CATEGORIES],
    denyKinds: [...SHARED_DENY_KINDS],
    humanizer: { ...DEFAULT_HUMANIZER },
    minScoreToStamp: DEFAULT_MIN_SCORE_TO_STAMP,
  },
  es: {
    acceptCategories: [...ACCEPT_CATEGORIES],
    denyKinds: [...SHARED_DENY_KINDS, 'Rewrite the sentence', 'Fix capitalization', 'Correct the mistake'],
    humanizer: { ...DEFAULT_HUMANIZER },
    minScoreToStamp: DEFAULT_MIN_SCORE_TO_STAMP,
  },
};

/** Whether a finished item may be stamped: dry runs never stamp anyway; an unreadable score stamps. */
export function shouldStamp(policy, score) {
  const bar = Number(policy?.minScoreToStamp) || 0;
  if (bar <= 0 || score == null) return true;
  return score >= bar;
}

/**
 * Resolve the accept policy for one language. `override` is the
 * settings.grammarPolicy value and may be either per-language
 * (`{ en: {...}, es: {...} }`) or the legacy flat shape
 * (`{ acceptCategories, denyKinds }`), which applies to every language.
 * Unknown languages fall back to the EN policy.
 */
export function policyFor(language, override) {
  const base = DEFAULT_POLICY[language] ?? DEFAULT_POLICY.en;
  if (!override || typeof override !== 'object') return { ...base };
  const perLanguage = override.en || override.es || override[language];
  const patch = perLanguage ? (override[language] ?? {}) : override;
  return { ...base, ...patch };
}

const contentTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out`)), ms)),
  ]);

/**
 * Every (article, language) whose stamp is empty, lowest id first, EN before
 * ES. Drafts are included only when settings.grammarIncludeDrafts is set.
 */
export async function grammarQueue(auth) {
  const { grammarIncludeDrafts = false } = await getSettings();
  const articles = await getArticles(auth);
  const queue = [];
  for (const a of [...articles].sort((x, y) => x.id - y.id)) {
    if (!grammarIncludeDrafts && a.status !== 'APPROVED') continue;
    if (a.has_content && !a.grammar_checked_en_at) {
      queue.push({ articleId: a.id, language: 'en', title: a.title });
    }
    if (a.has_spanish && !a.grammar_checked_es_at) {
      queue.push({ articleId: a.id, language: 'es', title: a.title_es || a.title });
    }
  }
  return queue;
}

export async function startGrammarRun(auth, { dryRun }) {
  const { grammarPolicy, grammarItemsPerRun } = await getSettings();
  const limit = Math.min(MAX_GRAMMAR_ITEMS_PER_RUN, Math.max(1, Number(grammarItemsPerRun) || MAX_GRAMMAR_ITEMS_PER_RUN));
  const queue = (await grammarQueue(auth)).slice(0, limit);
  if (queue.length === 0) throw new Error('No articles awaiting a grammar check');
  await patchExecutionState({
    phase: 'fetching_source',
    runType: 'grammar',
    suggestionTitle: `Grammar check — ${queue.length} item${queue.length === 1 ? '' : 's'}`,
    dryRun,
    queue,
    queueIndex: 0,
    itemResults: [],
    policies: {
      en: policyFor('en', grammarPolicy),
      es: policyFor('es', grammarPolicy),
    },
    accepted: [],
  });
  void executeGrammarRun(auth);
}

/** Chain through the queue; per-item API refusals are recorded, not fatal. */
export async function executeGrammarRun(auth) {
  claimWorker();
  try {
    for (;;) {
      const state = await getExecutionState();
      const item = state.queue?.[state.queueIndex];
      if (!item) {
        releaseWorker();
        await clearRunAlarms();
        await transition({ phase: 'done', finishedAt: new Date().toISOString() });
        return;
      }
      const result = await runItem(auth, state, item);
      const itemResults = [...(state.itemResults ?? []), result];
      await patchExecutionState({
        itemResults,
        queueIndex: state.queueIndex + 1,
        accepted: [],
        seen: [],
        acceptedSoFar: [],
        seenSoFar: [],
        stage: null,
        docUrl: null,
        fingerprint: null,
      });
    }
  } catch (error) {
    await failRun(error);
  }
}

/** Watchdog entry: the worker restarted mid-run. */
export async function resumeGrammarRun(auth, state) {
  console.info('[pic] resuming orphaned grammar run from phase', state.phase);
  if (!RESUMABLE_FROM_DOC.includes(state.phase) || !state.docUrl) {
    // Nothing was written yet: restart the current item from scratch.
    await transition({ phase: 'fetching_source', accepted: [], docUrl: null });
  }
  void executeGrammarRun(auth);
}

async function runItem(auth, state, item) {
  const { articleId, language, title } = item;
  const label = `#${articleId} ${language.toUpperCase()}`;
  const resumeFromDoc = RESUMABLE_FROM_DOC.includes(state.phase) && Boolean(state.docUrl);
  const base = { articleId, language, title };

  let source;
  let tabId;
  if (resumeFromDoc) {
    source = { fingerprint: state.fingerprint, block_count: state.blockCount };
    await transition({ suggestionTitle: `${label} — re-attaching after a worker restart` });
    tabId = await openDoc(state.docUrl, state.tabId);
    // If a content-script loop is still running in that tab (the worker
    // restarted, the page did not), keep polling it; if the page reloaded
    // the loop is gone and the stage restarts, which is safe: both loops
    // only look at what is still on the page, and everything accepted so
    // far is already in state.acceptedSoFar.
    if (state.phase === 'accepting' || state.phase === 'humanizing') {
      await runStages(tabId, state, itemPolicy(state, language), state.stage ?? 'grammar1');
    }
    await transition({ phase: 'extracting' });
  } else {
    await transition({ phase: 'fetching_source', suggestionTitle: `${label} — ${title}` });
    source = await getGrammarSource(auth, articleId, language);
    await patchExecutionState({ fingerprint: source.fingerprint, blockCount: source.block_count });

    // Refuse before any Grammarly doc is opened: an h4+ would silently read
    // back as h3 and be written to the article one level up (#28). Nothing
    // is pasted and nothing is stamped; the item is recorded and the run
    // moves on.
    const refusedHeadings = findRefusedHeadings(source.body_html);
    if (refusedHeadings.length > 0) {
      const error = headingRefusalReason(articleId, language, refusedHeadings);
      console.warn('[pic]', error);
      return {
        ...base,
        status: 'refused',
        accepted: 0,
        error,
        errorDetail: { headings: refusedHeadings },
      };
    }

    await transition({ phase: 'opening_grammarly' });
    tabId = await openDoc(NEW_DOC_URL, state.tabId);
    const tab = await chrome.tabs.get(tabId);
    await patchExecutionState({ docUrl: tab.url });

    await transition({ phase: 'pasting' });
    await send(tabId, { type: 'pic:grammarly:prepare' }, 90_000, 'prepare');
    const pasted = await send(tabId, { type: 'pic:grammarly:paste', html: source.body_html }, 60_000, 'paste');
    if (pasted.blockCount !== source.block_count) {
      console.warn('[pic] block count after paste', pasted.blockCount, 'vs source', source.block_count);
    }

    await transition({ phase: 'analysing' });
    const analysis = await send(tabId, { type: 'pic:grammarly:wait-analysis' }, 240_000, 'analysis');
    await patchExecutionState({ scoreBefore: analysis.score, countsBefore: analysis.counts });

    await patchExecutionState({ acceptedSoFar: [], seenSoFar: [] });
    await runStages(tabId, state, itemPolicy(state, language), 'grammar1');
    await transition({ phase: 'extracting' });
  }

  const current = await getExecutionState();
  const extracted = await send(tabId, { type: 'pic:grammarly:extract' }, 60_000, 'extract');

  await transition({ phase: 'applying' });
  const allAccepted = [...(current.acceptedSoFar ?? []), ...(current.accepted ?? [])];
  const acceptedItems = allAccepted.map(({ category, kind, before, after }) => ({
    category,
    kind,
    before,
    after,
  }));
  const humanized = allAccepted.filter((a) => a.category === 'Humanizer').length;
  // Per-item audit kept on the result (#23): what was accepted, and every
  // card the loop looked at with its decision (denied / stuck / seen on a
  // dry run), so the popup can show a run without the worker console.
  const allSeen = [...(current.seenSoFar ?? []), ...(current.seen ?? [])];
  const audit = {
    acceptedItems,
    humanized,
    seenItems: auditSeen(allSeen),
    suggestionsSeen: allSeen.length,
  };
  const stamp = shouldStamp(itemPolicy(state, language), extracted.score);
  try {
    const applied = await applyGrammar(auth, articleId, language, {
      body_html: extracted.html,
      fingerprint: source.fingerprint,
      dry_run: Boolean(state.dryRun),
      accepted: acceptedItems,
      stamp,
      score: extracted.score ?? undefined,
    });
    let status;
    if (state.dryRun) status = applied.changed ? 'dry_run_drift' : 'dry_run_ok';
    else if (applied.written) status = stamp ? 'applied' : 'applied_unstamped';
    else status = stamp ? 'stamped' : 'unstamped';
    if (!state.dryRun) chrome.tabs.remove(tabId).catch(() => {});
    return {
      ...base,
      ...audit,
      status,
      accepted: acceptedItems.length,
      scoreBefore: current.scoreBefore ?? null,
      scoreAfter: extracted.score,
      changed: applied.changed,
      diffPreview: applied.diff_preview,
      // Meaning check (#518): Sonnet reverted paragraphs before the write
      // and filed others for a human in the admin grid.
      meaningChecked: Boolean(applied.meaning_checked),
      revertedCount: applied.reverted_count ?? 0,
      reviewCount: applied.review_count ?? 0,
      resumed: resumeFromDoc,
    };
  } catch (error) {
    if (error instanceof ApiError && (error.status === 409 || error.status === 400)) {
      return {
        ...base,
        ...audit,
        status: error.status === 409 ? 'skipped' : 'refused',
        accepted: acceptedItems.length,
        error: error.message,
        errorDetail: error.detail,
        docUrl: current.docUrl,
      };
    }
    throw error;
  }
}

const MAX_AUDIT_SEEN = 400;
const MAX_AUDIT_SNIPPET = 160;

/** Compact the accept loop's `seen` list for the run state (bounded, snippets trimmed). */
function auditSeen(seen) {
  return (seen ?? []).slice(0, MAX_AUDIT_SEEN).map(({ category, kind, snippet, decision }) => ({
    category,
    kind,
    snippet: String(snippet ?? '').slice(0, MAX_AUDIT_SNIPPET),
    decision: decision ?? 'seen',
  }));
}

/** The policy for this item's language; a run saved by an older worker carried one flat `policy`. */
function itemPolicy(state, language) {
  return state.policies?.[language] ?? state.policy ?? policyFor(language);
}

// One item is three content-script loops in a row: Grammar-only accept,
// Humanizer rewrites, Grammar-only accept again (a rewrite surfaces new
// Grammar underlines). `stage` is persisted so a restarted worker resumes
// the loop it was polling instead of starting the item over.
const STAGES = ['grammar1', 'humanize', 'grammar2'];

async function runStages(tabId, state, policy, fromStage) {
  const humanizerOn = Boolean(policy.humanizer?.enabled);
  for (const stage of STAGES.slice(STAGES.indexOf(fromStage))) {
    if (stage !== 'grammar1' && !humanizerOn) break;
    // A dry run dismisses every rewrite, so pass 2 would only re-record pass 1's cards.
    if (stage === 'grammar2' && state.dryRun) break;
    const label = stage === 'humanize' ? 'humanizing' : 'accepting';
    await transition({ phase: label, stage, accepted: [], seen: [], progress: null });
    if (stage === 'humanize') {
      const status = await send(tabId, { type: 'pic:grammarly:humanize-status' }, 15_000, 'humanize status');
      if (status.status === 'none' || status.status === 'failed') {
        await send(
          tabId,
          { type: 'pic:grammarly:humanize', voice: policy.humanizer.voice, dryRun: state.dryRun },
          30_000,
          'humanize start',
        );
      }
      await pollLoop(tabId, 'pic:grammarly:humanize-status', 'humanize');
    } else {
      // The Humanizer pass leaves its panel on top; the accept loop reads
      // the proofread pills, so bring the Grammarly panel back first.
      if (stage === 'grammar2') {
        await send(tabId, { type: 'pic:grammarly:switch-to-proofread' }, 90_000, 'switch to proofread');
      }
      const status = await send(tabId, { type: 'pic:grammarly:accept-status' }, 15_000, 'accept status');
      // Start unless a loop is mid-flight. The content script keeps only its
      // last job, so a 'done' left over from pass 1 must not be read as pass
      // 2 having finished — restarting is safe, the loop only looks at what
      // is still on the page.
      if (status.status !== 'running') {
        await send(
          tabId,
          { type: 'pic:grammarly:accept', policy, dryRun: state.dryRun },
          30_000,
          'accept start',
        );
      }
      await pollLoop(tabId, 'pic:grammarly:accept-status', 'accept');
    }
    const done = await getExecutionState();
    await patchExecutionState({
      acceptedSoFar: [...(done.acceptedSoFar ?? []), ...(done.accepted ?? [])],
      seenSoFar: [...(done.seenSoFar ?? []), ...(done.seen ?? [])],
      accepted: [],
      seen: [],
    });
  }
}

const ACCEPT_POLL_MS = 3_000;
const ACCEPT_DEADLINE_MS = 40 * 60_000; // each Accept can cost a multi-second re-analysis

/** Poll a detached content-script loop until it reports done; persist progress as it goes. */
async function pollLoop(tabId, statusType, what) {
  const deadline = Date.now() + ACCEPT_DEADLINE_MS;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, ACCEPT_POLL_MS));
    const status = await send(tabId, { type: statusType }, 15_000, `${what} status`);
    if (status.status === 'none') throw new Error(`${what} loop vanished (tab reloaded?)`);
    await transition({
      accepted: status.accepted ?? [],
      seen: status.seen ?? [],
      progress: { done: status.accepted?.length ?? 0, remaining: status.remaining ?? null },
    });
    if (status.status === 'done') return status.result;
    if (status.status === 'failed') throw new Error(status.error ?? `${what} loop failed`);
    if (Date.now() > deadline) throw new Error(`${what} loop exceeded 40 minutes`);
  }
}

/** Grammarly re-titles the doc URL from its first heading; the id after the last "_" is stable. */
function docId(url) {
  const m = /^https:\/\/coda\.grammarly\.com\/d\/[^/]*_([A-Za-z0-9_-]+)\//.exec(url ?? '');
  return m ? m[1] : null;
}

async function send(tabId, message, timeoutMs, what) {
  const response = await contentTimeout(chrome.tabs.sendMessage(tabId, message), timeoutMs, what);
  if (!response?.ok) throw new Error(response?.error ?? `${what} failed`);
  return response;
}

/** Open (or reuse) a Grammarly doc tab and wait for our content script. */
async function openDoc(url, staleTabId) {
  if (staleTabId != null) {
    try {
      const stale = await chrome.tabs.get(staleTabId);
      if (docId(stale.url) && docId(stale.url) === docId(url)) {
        await waitForContentScript(staleTabId, GRAMMARLY_SCRIPT_TARGET);
        return staleTabId;
      }
    } catch {
      // gone
    }
  }
  const tab = await chrome.tabs.create({ url, active: true });
  if (staleTabId != null) chrome.tabs.remove(staleTabId).catch(() => {});
  await patchExecutionState({ tabId: tab.id });

  // /ddocs/new redirects to coda.grammarly.com/d/...; a signed-out session
  // lands on the auth host instead.
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await chrome.tabs.get(tab.id);
    if (current.url?.startsWith(DOC_URL_PREFIX)) break;
    if (/auth\.grammarly\.com|\/signin/.test(current.url ?? '')) {
      throw new Error('Grammarly is signed out in this Chrome profile — sign in and retry');
    }
    if (attempt === 59) throw new Error(`Grammarly doc never opened (last URL ${current.url})`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await waitForContentScript(tab.id, GRAMMARLY_SCRIPT_TARGET);
  return tab.id;
}

const GRAMMARLY_SCRIPT_TARGET = {
  ping: 'pic:grammarly:ping',
  files: GRAMMARLY_CONTENT_SCRIPTS,
  label: 'Grammarly',
};
