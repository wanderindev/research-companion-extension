// All persistent extension state lives in chrome.storage.local behind these
// accessors — the MV3 service worker can be killed at any moment, so nothing
// stateful may live in module scope.

const AUTH_KEY = 'picAuth';
const EXECUTION_KEY = 'picExecutionState';
const SETTINGS_KEY = 'picSettings';

const IDLE_STATE = { phase: 'idle' };
// dryRun defaults ON: a fresh install composes on claude.ai but never sends
// until the operator flips the toggle in the popup.
const DEFAULT_SETTINGS = { dryRun: true, grammarItemsPerRun: 10 };

// ---------- auth ----------

/** @returns {Promise<{token: string, email: string, expiresAt: string, apiBase: string} | null>} */
export async function getAuth() {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  return stored[AUTH_KEY] ?? null;
}

export async function setAuth(auth) {
  await chrome.storage.local.set({ [AUTH_KEY]: auth });
}

export async function clearAuth() {
  await chrome.storage.local.remove(AUTH_KEY);
}

// ---------- execution state (one run at a time; see docs/PLAN.md) ----------

export async function getExecutionState() {
  const stored = await chrome.storage.local.get(EXECUTION_KEY);
  return stored[EXECUTION_KEY] ?? { ...IDLE_STATE };
}

export async function setExecutionState(state) {
  await chrome.storage.local.set({ [EXECUTION_KEY]: state });
}

export async function patchExecutionState(patch) {
  const current = await getExecutionState();
  await setExecutionState({ ...current, ...patch });
}

export async function resetExecutionState() {
  await setExecutionState({ ...IDLE_STATE });
}

// ---------- settings ----------

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function patchSettings(patch) {
  const current = await getSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...current, ...patch } });
}
