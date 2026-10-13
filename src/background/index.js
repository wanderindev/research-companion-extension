// Service worker: orchestrator and PIC API gateway.
// Message router for the popup and content scripts. Everything async;
// state persists via ./state.js (the worker can be killed at any moment).

import { MSG } from '../shared/messages.js';
import {
  apiBaseForOrigin,
  getFactCheckSummary,
  getSuggestionsForResearch,
  verifyToken,
} from './pic-api.js';
import { grammarQueue } from './grammar-run.js';
import { cancelRun, poll, POLL_ALARM, startRun, transition, watchdog, WATCHDOG_ALARM } from './run.js';
import {
  clearAuth,
  getAuth,
  getExecutionState,
  getSettings,
  patchSettings,
  setAuth,
} from './state.js';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  dispatch(message)
    .then(sendResponse)
    .catch((err) =>
      sendResponse({ ok: false, error: err?.message ?? String(err), status: err?.status }),
    );
  return true; // keep the channel open for the async response
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll();
  else if (alarm.name === WATCHDOG_ALARM) watchdog();
});

async function dispatch(message) {
  switch (message?.type) {
    case MSG.tokenCaptured:
      return handleTokenCaptured(message);
    case MSG.getAuth:
      return { ok: true, auth: await getValidAuth() };
    case MSG.listSuggestions:
      return handleListSuggestions();
    case MSG.startRun:
      await startRun({
        runType: message.runType,
        suggestionId: message.suggestionId,
        suggestionTitle: message.suggestionTitle,
      });
      return { ok: true, run: await getExecutionState() };
    case MSG.getFactCheckPending:
      return handleFactCheckPending();
    case MSG.getGrammarPending:
      return handleGrammarPending();
    case MSG.grammarProgress:
      return handleGrammarProgress(message);
    case MSG.getRun:
      // Lazy health check: opening the popup surfaces orphaned runs
      // immediately instead of waiting for the next watchdog tick.
      await watchdog();
      return { ok: true, run: await getExecutionState(), settings: await getSettings() };
    case MSG.cancelRun:
      await cancelRun();
      return { ok: true };
    case MSG.patchSettings:
      await patchSettings(message.patch ?? {});
      return { ok: true, settings: await getSettings() };
    default:
      return { ok: false, error: `Unknown message type: ${message?.type}` };
  }
}

/** Returns stored auth, clearing and returning null if expired. */
async function getValidAuth() {
  const auth = await getAuth();
  if (!auth) return null;
  if (auth.expiresAt && Date.parse(auth.expiresAt) <= Date.now()) {
    await clearAuth();
    return null;
  }
  return auth;
}

async function handleTokenCaptured({ token, email, origin }) {
  const existing = await getValidAuth();
  if (existing?.token === token) return { ok: true, unchanged: true };

  const apiBase = apiBaseForOrigin(origin);
  const verified = await verifyToken(apiBase, token);
  if (!verified.valid || verified.action !== 'ADMIN_ACCESS') {
    return { ok: false, error: 'Captured token is not a valid admin token' };
  }
  await setAuth({
    token,
    email: email || verified.admin_email,
    expiresAt: verified.expires_at,
    apiBase,
  });
  return { ok: true };
}

async function handleListSuggestions() {
  const auth = await getValidAuth();
  if (!auth) return { ok: false, error: 'not_authenticated' };
  const suggestions = await getSuggestionsForResearch(auth);
  return { ok: true, suggestions };
}

/** Total claims awaiting the deep-research loop, across all subjects. */
async function handleFactCheckPending() {
  const auth = await getValidAuth();
  if (!auth) return { ok: false, error: 'not_authenticated' };
  const summary = await getFactCheckSummary(auth);
  const pending = summary.reduce(
    (sum, item) => sum + (item.counts?.NEEDS_DEEP_RESEARCH ?? 0),
    0,
  );
  return { ok: true, pending };
}

/** (article, language) pairs still missing a grammar stamp. */
async function handleGrammarPending() {
  const auth = await getValidAuth();
  if (!auth) return { ok: false, error: 'not_authenticated' };
  const queue = await grammarQueue(auth);
  return {
    ok: true,
    pending: queue.length,
    en: queue.filter((q) => q.language === 'en').length,
    es: queue.filter((q) => q.language === 'es').length,
    queue,
  };
}

/**
 * Accept-loop heartbeat from the Grammarly content script: persists what has
 * been accepted so far (the watchdog resumes from it) and refreshes
 * phaseChangedAt so a long loop is not mistaken for a stall.
 */
async function handleGrammarProgress({ accepted, done, remaining }) {
  const state = await getExecutionState();
  if (state.runType !== 'grammar' || state.phase !== 'accepting') return { ok: true, ignored: true };
  await transition({ accepted: accepted ?? state.accepted, progress: { done, remaining } });
  return { ok: true };
}
