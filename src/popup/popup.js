import { MSG } from '../shared/messages.js';
import { DECISION_LABELS, GRAMMAR_STATUS_LABELS, groupSeen, itemHeadline, runStateJson } from './grammar-audit.js';

const el = (id) => document.getElementById(id);

const PHASE_LABELS = {
  idle: 'Idle',
  generating_prompt: 'Generating research prompt…',
  opening_claude: 'Opening claude.ai…',
  composing: 'Composing on claude.ai…',
  researching: 'Researching (15–40 min)…',
  uploading: 'Uploading research to PIC…',
  fetching_source: 'Fetching article body from PIC…',
  opening_grammarly: 'Opening a Grammarly doc…',
  pasting: 'Pasting into Grammarly…',
  analysing: 'Waiting for Grammarly analysis…',
  accepting: 'Accepting suggestions…',
  humanizing: 'Humanizer rewrites…',
  extracting: 'Reading the corrected document…',
  applying: 'Applying to PIC…',
  done: 'Done ✔',
  failed: 'Failed ✖',
};

const TERMINAL_PHASES = ['idle', 'done', 'failed'];

let refreshTimer = null;

async function send(type, payload = {}) {
  return chrome.runtime.sendMessage({ type, ...payload });
}

function showError(message) {
  el('error').textContent = message;
  el('error').hidden = !message;
}

function describeGrammarRun(run) {
  const results = run.itemResults ?? [];
  if (results.length === 0) return '';
  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const accepted = results.reduce((sum, r) => sum + (r.accepted ?? 0), 0);
  const summary = Object.entries(counts)
    .map(([status, n]) => `${n} ${GRAMMAR_STATUS_LABELS[status] ?? status}`)
    .join(', ');
  return `${results.length} item${results.length === 1 ? '' : 's'}: ${summary}; ${accepted} suggestions accepted`;
}

function describeUploadResult(run) {
  if (run.runType === 'grammar') return describeGrammarRun(run);
  if (run.runType === 'fact_check') {
    const totals = run.totals;
    if (!totals) return '';
    return (
      `${totals.batches} batch${totals.batches === 1 ? '' : 'es'}: ` +
      `${totals.written} verdicts written, ${totals.skipped} skipped, ` +
      `${totals.missing} unanswered, ${totals.kbUpserts} KB entries — ` +
      (run.chainStopReason ?? 'queue drained')
    );
  }
  const result = run.uploadResult;
  if (!result) return '';
  return (
    `Uploaded: ${result.word_count} words, status ${result.status}` +
    (result.references_generated ? ' (references auto-generated)' : '')
  );
}

function renderRun(run) {
  const active = run && run.phase !== 'idle';
  el('run-panel').hidden = !active;
  if (!active) return;

  const running = !TERMINAL_PHASES.includes(run.phase);
  let phaseText = PHASE_LABELS[run.phase] ?? run.phase;
  if (running && run.startedAt) {
    const minutes = Math.round((Date.now() - Date.parse(run.startedAt)) / 60_000);
    phaseText += ` (${minutes} min elapsed)`;
  }
  el('run-phase').textContent = phaseText;
  el('run-phase').className = `phase phase-${run.phase}`;
  el('run-suggestion').textContent = run.suggestionTitle
    ? `${run.suggestionTitle}${run.dryRun ? ' — dry run' : ''}`
    : '';

  const note = run.note ?? (run.phase === 'done' ? describeUploadResult(run) : '');
  el('run-note').textContent = note;
  el('run-note').hidden = !note;

  el('run-error').textContent = run.error ?? '';
  el('run-error').hidden = !run.error;

  renderGrammarItems(run);

  el('cancel-run').textContent = running ? 'Cancel' : 'Clear';
}

function renderGrammarItems(run) {
  let list = el('grammar-items');
  if (!list) {
    list = document.createElement('ul');
    list.id = 'grammar-items';
    list.className = 'item-results';
    el('run-panel').append(list);
  }
  // Keep the operator's expanded items open across the 5 s refresh tick.
  const open = new Set(
    [...list.querySelectorAll('details[open]')].map((d) => d.dataset.item),
  );
  list.replaceChildren();
  if (run.runType !== 'grammar') return;
  for (const r of run.itemResults ?? []) {
    const li = document.createElement('li');
    li.append(renderGrammarItem(r, open));
    list.append(li);
  }
  if ((run.phase === 'accepting' || run.phase === 'humanizing') && run.progress) {
    const li = document.createElement('li');
    li.textContent = `current (${run.stage ?? run.phase}): ${run.progress.done} accepted, ${run.progress.remaining} cards left`;
    list.append(li);
  }
}

const h = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

/** One item as a <details>: headline, then accepted before/after, held-back kinds, diff, gate counts. */
function renderGrammarItem(r, open) {
  const key = `${r.articleId}:${r.language}`;
  const details = h('details', 'item-audit');
  details.dataset.item = key;
  details.open = open.has(key);
  details.append(h('summary', null, itemHeadline(r)));

  const body = h('div', 'audit-body');

  if (r.errorDetail != null) {
    body.append(h('h4', null, 'Reason'));
    const detail = typeof r.errorDetail === 'string' ? r.errorDetail : JSON.stringify(r.errorDetail, null, 2);
    body.append(h('pre', null, detail));
  }

  if (r.meaningChecked) {
    body.append(
      h(
        'p',
        'gate',
        `Sonnet meaning check: ${r.revertedCount ?? 0} paragraph(s) reverted before the write, ` +
          `${r.reviewCount ?? 0} filed for review — see the "to review" pill in the admin articles grid.`,
      ),
    );
  }

  const accepted = r.acceptedItems ?? [];
  if (accepted.length > 0) {
    body.append(h('h4', null, `Accepted (${accepted.length})`));
    const ul = h('ul');
    for (const a of accepted) {
      const li = h('li');
      li.append(h('span', 'kind', `${a.kind || a.category || '?'}: `));
      li.append(h('span', 'before', a.before ?? ''));
      li.append(document.createTextNode(' → '));
      li.append(h('span', 'after', a.after ?? ''));
      ul.append(li);
    }
    body.append(ul);
  }

  const groups = groupSeen(r.seenItems).filter((g) => g.decision !== 'accepted');
  if (groups.length > 0) {
    body.append(h('h4', null, `Suggestions seen (${r.suggestionsSeen ?? r.seenItems?.length ?? 0})`));
    const ul = h('ul');
    for (const g of groups) {
      const li = h('li');
      li.append(
        document.createTextNode(`${g.count}× ${g.category ? `${g.category} · ` : ''}${g.kind || '?'} — ${DECISION_LABELS[g.decision] ?? g.decision}`),
      );
      if (g.snippets.length > 0) {
        li.append(document.createElement('br'));
        li.append(h('span', 'example', g.snippets.map((x) => `“${x}”`).join(' · ')));
      }
      ul.append(li);
    }
    body.append(ul);
  }

  if (r.status === 'dry_run_drift' && Array.isArray(r.diffPreview) && r.diffPreview.length > 0) {
    body.append(h('h4', null, 'Round-trip diff preview'));
    body.append(h('pre', null, r.diffPreview.join('\n')));
  }

  if (r.docUrl) {
    const p = h('p');
    const a = h('a', null, 'Open the Grammarly doc');
    a.href = r.docUrl;
    a.target = '_blank';
    a.rel = 'noreferrer';
    p.append(a);
    body.append(p);
  }

  if (body.childElementCount === 0) body.append(h('p', 'kind', 'Nothing recorded for this item.'));
  details.append(body);
  return details;
}

function renderSuggestions(suggestions, runActive) {
  const list = el('suggestions');
  list.replaceChildren();
  el('empty').hidden = suggestions.length > 0;

  for (const suggestion of suggestions) {
    const li = document.createElement('li');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = suggestion.title;
    title.title = suggestion.title;
    const category = document.createElement('span');
    category.className = 'category';
    category.textContent = suggestion.category_name ?? '';
    meta.append(title, category);

    const start = document.createElement('button');
    start.type = 'button';
    start.textContent = 'Start';
    start.disabled = runActive;
    start.title = runActive ? 'A run is already in progress' : 'Start the research run';
    start.addEventListener('click', async () => {
      start.disabled = true;
      const response = await send(MSG.startRun, {
        runType: 'research',
        suggestionId: suggestion.id,
        suggestionTitle: suggestion.title,
      });
      if (!response.ok) showError(response.error);
      await refresh();
    });

    li.append(meta, start);
    list.append(li);
  }
}

async function refresh() {
  showError('');
  const authResponse = await send(MSG.getAuth);
  const auth = authResponse?.auth;

  el('signed-out').hidden = Boolean(auth);
  el('auth-badge').hidden = !auth;

  const runResponse = await send(MSG.getRun);
  const run = runResponse?.run;
  renderRun(run);
  el('dry-run').checked = Boolean(runResponse?.settings?.dryRun);
  el('gr-limit').value = runResponse?.settings?.grammarItemsPerRun ?? 10;

  // Keep the popup live while a run is in flight.
  const running = run && !TERMINAL_PHASES.includes(run.phase);
  clearInterval(refreshTimer);
  if (running) refreshTimer = setInterval(refresh, 5_000);

  // While a run is active the suggestions section stays hidden — no point
  // hitting the API every refresh tick just to show disabled Start buttons.
  el('signed-in').hidden = !auth || Boolean(running);

  if (!auth) return;
  el('auth-badge').textContent = auth.email;
  el('auth-badge').title = `Token expires ${new Date(auth.expiresAt).toLocaleString()}`;
  if (running) return;

  const response = await send(MSG.listSuggestions);
  if (!response.ok) {
    showError(
      response.error === 'not_authenticated'
        ? 'Session expired — open the admin panel to sign in again.'
        : `Could not load suggestions: ${response.error}`,
    );
    return;
  }
  renderSuggestions(response.suggestions, Boolean(running));
  await refreshFactCheck();
  await refreshGrammar();
}

async function refreshGrammar() {
  const response = await send(MSG.getGrammarPending);
  if (!response.ok) {
    el('gr-pending').textContent = `Could not load: ${response.error}`;
    el('gr-start').disabled = true;
    return;
  }
  const { pending, en, es } = response;
  el('gr-pending').textContent =
    pending === 0
      ? 'Every approved article is grammar-checked'
      : `${pending} pending (EN ${en}, ES ${es})`;
  el('gr-start').disabled = pending === 0;
}

async function refreshFactCheck() {
  const response = await send(MSG.getFactCheckPending);
  if (!response.ok) {
    el('fc-pending').textContent = `Could not load: ${response.error}`;
    el('fc-start').disabled = true;
    return;
  }
  const pending = response.pending;
  el('fc-pending').textContent =
    pending === 0
      ? 'No claims awaiting deep research'
      : `${pending} claim${pending === 1 ? '' : 's'} awaiting deep research`;
  el('fc-start').disabled = pending === 0;
}

el('fc-start').addEventListener('click', async () => {
  el('fc-start').disabled = true;
  const response = await send(MSG.startRun, {
    runType: 'fact_check',
    suggestionTitle: 'Deep-research fact-check batch',
  });
  if (!response.ok) showError(response.error);
  await refresh();
});
el('gr-start').addEventListener('click', async () => {
  el('gr-start').disabled = true;
  const response = await send(MSG.startRun, { runType: 'grammar' });
  if (!response.ok) showError(response.error);
  await refresh();
});
el('open-admin').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://panamaincontext.com/admin' });
});
el('refresh').addEventListener('click', refresh);
el('copy-run').addEventListener('click', async () => {
  const runResponse = await send(MSG.getRun);
  const button = el('copy-run');
  try {
    await navigator.clipboard.writeText(runStateJson(runResponse?.run));
    button.textContent = 'Copied ✔';
  } catch (err) {
    showError(`Could not copy: ${err?.message ?? err}`);
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = 'Copy state';
  }, 1500);
});
el('cancel-run').addEventListener('click', async () => {
  await send(MSG.cancelRun);
  await refresh();
});
el('gr-limit').addEventListener('change', async (event) => {
  const value = Math.min(10, Math.max(1, Number(event.target.value) || 10));
  event.target.value = value;
  await send(MSG.patchSettings, { patch: { grammarItemsPerRun: value } });
});
el('dry-run').addEventListener('change', async (event) => {
  await send(MSG.patchSettings, { patch: { dryRun: event.target.checked } });
});

refresh().catch((err) => showError(String(err?.message ?? err)));
