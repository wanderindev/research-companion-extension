// Research-run orchestrator: the state machine from docs/PLAN.md.
// Every transition persists via state.js — the worker can die at any moment
// and the chrome.alarms poll ticks re-enter through poll().
//
// MV3 worker-death defenses (a run got orphaned in testing without these):
// 1. While THIS worker instance owns a phase (prompt/compose/upload), a
//    20 s keepalive pings a cheap extension API so Chrome's ~30 s idle
//    reaper doesn't kill the worker mid-fetch.
// 2. A 1-min watchdog alarm detects runs orphaned by a worker restart
//    (ownership is an in-memory flag, so a fresh worker knows the run's
//    promise chain is gone): uploads resume from the stored markdown,
//    everything else fails fast with a clear message instead of hanging.
// 3. startRun acks immediately; the pipeline continues detached.

import { GRAMMAR_PHASES } from './grammar-phases.js';
import { resumeGrammarRun, startGrammarRun } from './grammar-run.js';
import {
  generateFactCheckPrompt,
  generateResearchPrompt,
  uploadFactCheckVerdicts,
  uploadResearch,
} from './pic-api.js';
import {
  getAuth,
  getExecutionState,
  getSettings,
  patchExecutionState,
  resetExecutionState,
  setExecutionState,
} from './state.js';

export const POLL_ALARM = 'pic:research-poll';
export const WATCHDOG_ALARM = 'pic:watchdog';

const RESEARCH_TIMEOUT_MS = 90 * 60_000;
// Runaway backstop for chained fact-check batches (issue #9).
const MAX_FACT_CHECK_BATCHES = 10;
const WORKER_PHASE_TIMEOUT_MS = 6 * 60_000; // > generate-prompt's 3-min fetch timeout
const MAX_ENDED_WITHOUT_ARTIFACT_POLLS = 10; // artifact may attach after the turn ends
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const TERMINAL_PHASES = ['idle', 'done', 'failed'];
// Phases driven by an in-worker promise chain (vs. alarm-driven researching).
const WORKER_BOUND_PHASES = [
  'generating_prompt',
  'opening_claude',
  'composing',
  'uploading',
  // Grammar runs are worker-driven end to end (the Grammarly content script
  // answers each command; nothing is alarm-polled).
  ...GRAMMAR_PHASES,
];

let ownedByThisWorker = false;
let keepAliveTimer = null;

export function claimWorker() {
  ownedByThisWorker = true;
  if (!keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000);
  }
}

export function releaseWorker() {
  ownedByThisWorker = false;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
}

export async function clearRunAlarms() {
  await chrome.alarms.clear(POLL_ALARM);
  await chrome.alarms.clear(WATCHDOG_ALARM);
}

export async function transition(patch) {
  console.info('[pic] phase ->', patch.phase ?? '(patch)', patch);
  await patchExecutionState({ ...patch, phaseChangedAt: new Date().toISOString() });
}

async function requireAuth() {
  const auth = await getAuth();
  if (!auth || (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now())) {
    throw new Error('Not signed in — open the PIC admin panel to refresh the session');
  }
  return auth;
}

const CLAUDE_CONTENT_SCRIPTS = [
  'src/content/claude/selectors.js',
  'src/content/claude/wait-utils.js',
  'src/content/claude/dom-utils.js',
  'src/content/claude/claude-api.js',
  'src/content/claude/main.js',
];

const CLAUDE_SCRIPT_TARGET = {
  ping: 'pic:claude:ping',
  files: CLAUDE_CONTENT_SCRIPTS,
  label: 'claude.ai',
};

/** Ping the site driver in `tabId` until it answers, self-injecting once. */
export async function waitForContentScript(tabId, target = CLAUDE_SCRIPT_TARGET) {
  let lastPingError = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const pong = await chrome.tabs.sendMessage(tabId, { type: target.ping });
      if (pong?.ok) return;
    } catch (err) {
      lastPingError = err;
    }
    // Self-heal: if the declarative injection didn't land (extension just
    // reloaded, slow document_idle, …), inject programmatically once.
    if (attempt === 6) {
      try {
        console.info('[pic] ping not answered after 3 s — injecting content scripts');
        await chrome.scripting.executeScript({
          target: { tabId },
          files: target.files,
        });
      } catch (err) {
        console.warn('[pic] programmatic injection failed:', err);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `${target.label} tab never became ready (last ping error: ${lastPingError?.message ?? 'none'})`,
  );
}

export async function failRun(error) {
  console.warn('[pic] run failed:', error);
  releaseWorker();
  await clearRunAlarms();
  await transition({
    phase: 'failed',
    error: error?.message ?? String(error),
    errorDetail: error?.detail ?? null,
    failedAt: new Date().toISOString(),
  });
}

export async function startRun({ runType = 'research', suggestionId, suggestionTitle } = {}) {
  const current = await getExecutionState();
  if (!TERMINAL_PHASES.includes(current.phase)) {
    throw new Error(`A run is already in progress (${current.phase}) — cancel it first`);
  }
  const auth = await requireAuth();
  const { dryRun } = await getSettings();

  claimWorker();
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });

  if (runType === 'grammar') {
    await setExecutionState({
      phase: 'fetching_source',
      runType,
      dryRun,
      startedAt: new Date().toISOString(),
      phaseChangedAt: new Date().toISOString(),
    });
    try {
      await startGrammarRun(auth, { dryRun });
    } catch (error) {
      await failRun(error); // surfaced in the run panel (e.g. nothing pending)
    }
    return;
  }

  await setExecutionState({
    phase: 'generating_prompt',
    runType,
    suggestionId,
    suggestionTitle,
    dryRun,
    startedAt: new Date().toISOString(),
    phaseChangedAt: new Date().toISOString(),
  });

  // Detached on purpose: the caller (popup) gets an immediate ack and
  // follows progress via getRun. executeRun handles its own failures.
  void executeRun(auth, { runType, suggestionId, dryRun });
}

/**
 * Fetch the next fact-check batch and record it in state, or return null
 * when the chain should end: queue drained (404 after ≥1 batch), every
 * claim in the new batch already attempted this run (unresolvable
 * retreads would loop forever), or the batch-count backstop.
 */
async function nextFactCheckBatch(auth) {
  const state = await getExecutionState();
  const attempted = state.attemptedClaimIds ?? [];
  const batchNumber = (state.batchNumber ?? 0) + 1;

  if (batchNumber > MAX_FACT_CHECK_BATCHES) {
    await patchExecutionState({
      chainStopReason: `batch backstop (${MAX_FACT_CHECK_BATCHES}) reached with claims still pending`,
    });
    return null;
  }

  let batch;
  try {
    batch = await generateFactCheckPrompt(auth);
  } catch (error) {
    if (error?.status === 404) {
      if (batchNumber === 1) throw new Error('No claims awaiting deep research');
      return null; // queue drained
    }
    throw error;
  }

  if (batch.claim_ids.every((id) => attempted.includes(id))) {
    await patchExecutionState({
      chainStopReason: `${batch.pending_total} claims could not be resolved automatically`,
    });
    return null;
  }

  const remaining = batch.pending_total - batch.claim_count;
  await patchExecutionState({
    batchNumber,
    batchId: batch.batch_id,
    claimIds: batch.claim_ids,
    pendingTotal: batch.pending_total,
    attemptedClaimIds: [...attempted, ...batch.claim_ids.filter((id) => !attempted.includes(id))],
    suggestionTitle:
      `Fact-check batch ${batchNumber} — ${batch.claim_count} claims` +
      (remaining > 0 ? ` (≈${remaining} more pending)` : ''),
  });
  return batch.prompt_text;
}

/** Chain finished (drained / retreads / backstop) — the totals tell the story. */
async function finishFactCheckChain() {
  releaseWorker();
  await clearRunAlarms();
  await transition({ phase: 'done', finishedAt: new Date().toISOString() });
}

async function executeRun(auth, { runType, suggestionId, dryRun }) {
  try {
    let prompt;
    if (runType === 'fact_check') {
      prompt = await nextFactCheckBatch(auth);
      if (prompt === null) {
        await finishFactCheckChain();
        return;
      }
    } else {
      ({ prompt_text: prompt } = await generateResearchPrompt(auth, suggestionId));
    }

    // Chained batches leave the previous batch's tab in state; note it so
    // it can be closed once the replacement exists (removing it first
    // could close its whole window).
    const staleTabId = (await getExecutionState()).tabId ?? null;

    await transition({ phase: 'opening_claude' });
    const tab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: true });
    if (staleTabId != null) {
      chrome.tabs.remove(staleTabId).catch(() => {});
    }
    await waitForContentScript(tab.id);

    await transition({ phase: 'composing', tabId: tab.id });
    const composed = await chrome.tabs.sendMessage(tab.id, {
      type: 'pic:claude:compose',
      prompt,
      dryRun,
    });
    if (!composed?.ok) throw new Error(composed?.error ?? 'compose failed');

    if (dryRun) {
      releaseWorker();
      await clearRunAlarms();
      await transition({
        phase: 'done',
        note: 'Dry run: prompt composed on claude.ai but NOT sent.',
      });
      return;
    }

    await transition({
      phase: 'researching',
      conversationUuid: composed.conversationUuid,
      connectorsModalAppeared: composed.connectorsModalAppeared,
      endedWithoutArtifactPolls: 0,
      pollErrors: 0,
      // The research timeout is per batch — a chained fact-check run can
      // legitimately outlast several research windows end to end.
      batchStartedAt: new Date().toISOString(),
    });
    releaseWorker(); // researching is alarm-driven; the worker may sleep
    chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  } catch (error) {
    await failRun(error);
  }
}

/**
 * Watchdog: runs every minute (and on popup getRun). Detects runs whose
 * driving promise chain died with a worker restart, and in-worker phases
 * that have stalled past any plausible duration.
 */
export async function watchdog() {
  const state = await getExecutionState();
  if (TERMINAL_PHASES.includes(state.phase)) {
    await chrome.alarms.clear(WATCHDOG_ALARM);
    return;
  }
  if (!WORKER_BOUND_PHASES.includes(state.phase)) return; // researching → poll()

  if (!ownedByThisWorker) {
    // Orphaned by a service-worker restart.
    if (state.runType === 'grammar') {
      try {
        await resumeGrammarRun(await requireAuth(), state);
      } catch (error) {
        await failRun(error);
      }
      return;
    }
    if (state.phase === 'uploading' && state.markdown) {
      console.info('[pic] resuming orphaned upload');
      await finishRun(state, { markdown: state.markdown, title: state.artifactTitle });
      return;
    }
    if (state.phase === 'composing') {
      await failRun(
        new Error(
          'Interrupted while composing on claude.ai (service worker restarted). ' +
            'Check the claude.ai tab before retrying — the prompt may already have been sent.',
        ),
      );
      return;
    }
    await failRun(
      new Error(
        'Interrupted by a service-worker restart before reaching claude.ai. ' +
          'Safe to retry — click Start again.',
      ),
    );
    return;
  }

  const phaseAge = Date.now() - Date.parse(state.phaseChangedAt ?? state.startedAt);
  if (phaseAge > WORKER_PHASE_TIMEOUT_MS) {
    await failRun(
      new Error(`Step "${state.phase}" stalled for over ${WORKER_PHASE_TIMEOUT_MS / 60_000} minutes`),
    );
  }
}

/**
 * The completion check runs via the internal API, which works from ANY
 * claude.ai page — we just need a live tab with our content script.
 */
async function ensureClaudeTab(state) {
  if (state.tabId != null) {
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.url?.startsWith('https://claude.ai/')) return state.tabId;
    } catch {
      // tab was closed
    }
  }
  const tab = await chrome.tabs.create({
    url: `https://claude.ai/chat/${state.conversationUuid}`,
    active: false,
  });
  await waitForContentScript(tab.id);
  await patchExecutionState({ tabId: tab.id });
  return tab.id;
}

export async function poll() {
  const state = await getExecutionState();
  if (state.phase !== 'researching') {
    await chrome.alarms.clear(POLL_ALARM);
    return;
  }
  if (Date.parse(state.batchStartedAt ?? state.startedAt) + RESEARCH_TIMEOUT_MS < Date.now()) {
    await failRun(new Error('Research timed out after 90 minutes'));
    return;
  }

  try {
    const tabId = await ensureClaudeTab(state);
    const result = await chrome.tabs.sendMessage(tabId, {
      type: 'pic:claude:check',
      conversationUuid: state.conversationUuid,
    });
    if (!result?.ok) throw new Error(result?.error ?? 'completion check failed');

    if (result.state === 'completed') {
      await finishRun(state, result);
    } else if (result.state === 'ended_without_artifact') {
      const count = (state.endedWithoutArtifactPolls ?? 0) + 1;
      if (count >= MAX_ENDED_WITHOUT_ARTIFACT_POLLS) {
        await failRun(
          new Error(`Conversation ended without a research artifact: ${result.reason ?? 'unknown'}`),
        );
      } else {
        await patchExecutionState({
          endedWithoutArtifactPolls: count,
          pollErrors: 0,
          lastPollAt: new Date().toISOString(),
        });
      }
    } else {
      await patchExecutionState({
        endedWithoutArtifactPolls: 0,
        pollErrors: 0,
        lastPollAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    // Transient hiccups (tab reload, network blip) must not kill a 40-minute
    // run — only repeated consecutive failures do.
    const errors = (state.pollErrors ?? 0) + 1;
    if (errors >= MAX_CONSECUTIVE_POLL_ERRORS) {
      await failRun(error);
    } else {
      await patchExecutionState({
        pollErrors: errors,
        lastError: error?.message ?? String(error),
        lastPollAt: new Date().toISOString(),
      });
    }
  }
}

async function finishRun(state, { markdown, title }) {
  claimWorker();
  await chrome.alarms.clear(POLL_ALARM);
  // Keep the markdown until upload succeeds so a failed upload can be
  // retried (the watchdog resumes orphaned uploads from it).
  await transition({ phase: 'uploading', markdown, artifactTitle: title });

  try {
    const auth = await requireAuth();

    if (state.runType === 'fact_check') {
      const uploadResult = await uploadFactCheckVerdicts(auth, markdown, state.claimIds);
      const prev = state.totals ?? { batches: 0, written: 0, skipped: 0, missing: 0, kbUpserts: 0 };
      await patchExecutionState({
        totals: {
          batches: prev.batches + 1,
          written: prev.written + (uploadResult.written ?? 0),
          skipped: prev.skipped + (uploadResult.skipped?.length ?? 0),
          missing: prev.missing + (uploadResult.missing_claim_ids?.length ?? 0),
          kbUpserts: prev.kbUpserts + (uploadResult.kb_upserts ?? 0),
        },
        uploadResult,
        markdown: null,
        conversationUuid: null,
        endedWithoutArtifactPolls: 0,
        pollErrors: 0,
      });
      // Auto-continue (issue #9): chain the next batch through the same
      // state machine; executeRun ends the run when the queue is drained.
      await transition({ phase: 'generating_prompt' });
      void executeRun(auth, { runType: 'fact_check', dryRun: false });
      return;
    }

    const uploadResult = await uploadResearch(auth, state.suggestionId, markdown);
    releaseWorker();
    await clearRunAlarms();
    await transition({
      phase: 'done',
      uploadResult,
      markdown: null,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    await failRun(error);
  }
}

export async function cancelRun() {
  releaseWorker();
  await clearRunAlarms();
  await resetExecutionState();
}
