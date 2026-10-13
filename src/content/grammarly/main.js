// coda.grammarly.com automation entry point. Executes commands from the
// service worker for one article/language: prepare the side panel, paste the
// body HTML, wait for the analysis, accept suggestions by policy, and read
// the corrected document back. Selectors: selectors.js + docs/grammarly-recon.md.

(() => {
  if (window.__picGrammarlyLoaded) return;
  window.__picGrammarlyLoaded = true;

  const PIC = (window.PIC ??= {});
  const S = PIC.GRAMMARLY_SELECTORS;
  const log = (...args) => console.info('[pic]', ...args);

  log('grammarly content script ready on', location.pathname);

  const ANALYSIS_TIMEOUT_MS = 180_000; // a 3,600-word doc took >60 s to analyse
  const REANALYSIS_TIMEOUT_MS = 90_000; // after an Accept the panel re-analyses (skeleton again on long docs)
  const ANALYSIS_STABLE_POLLS = 3; // card count unchanged for N consecutive 1 s polls
  const MAX_ACCEPT_ITERATIONS = 300;
  const MAX_PASSES = 3;
  const MAX_STUCK_CARDS = 3;
  const DIFF_CONTEXT_CHARS = 40;

  // ---------- helpers ----------

  function cards() {
    return PIC.dom.queryAll(S.suggestionCard);
  }

  function expandedCard() {
    return PIC.dom.query(S.suggestionCardExpanded);
  }

  function pill(category) {
    const re = new RegExp(`^${category}\\b`, 'i');
    return PIC.dom.queryAll(S.categoryPill).find((b) => re.test(b.innerText.trim()));
  }

  // Pill text is "Grammar 11", "Delivery" (zero, rendered as a tick) or
  // "All 99+" (capped) — counts are numbers, `capped` remembers the "+".
  function pillCounts() {
    const counts = {};
    for (const b of PIC.dom.queryAll(S.categoryPill)) {
      const m = /^(All|Grammar|Clarity|Delivery)\s*(\d+)?(\+)?/i.exec(b.innerText.trim());
      if (m) {
        counts[m[1]] = m[2] ? Number(m[2]) : 0;
        if (m[3]) (counts.capped ??= new Set()).add(m[1]);
      }
    }
    return counts;
  }

  function overallScore() {
    const el = PIC.dom.query(S.overallScore);
    const m = /^(\d{1,3})/.exec(el?.innerText.trim() ?? '');
    return m ? Number(m[1]) : null;
  }

  function cardIdentity(card) {
    const h2 = card.querySelector('h2')?.textContent.trim() ?? '';
    const h3 = card.querySelector('h3')?.textContent.trim() ?? '';
    return `${h2} :: ${h3}`;
  }

  function cardSnippet(card) {
    return (card.querySelector('h2')?.textContent ?? '').replace(/^suggestion for\s*/i, '').trim();
  }

  /** The first line that differs between two text snapshots, trimmed to context. */
  function firstDiff(before, after) {
    const a = before.split('\n');
    const b = after.split('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i >= a.length && i >= b.length) return null;
    const oldLine = a[i] ?? '';
    const newLine = b[i] ?? '';
    let p = 0;
    while (p < oldLine.length && p < newLine.length && oldLine[p] === newLine[p]) p++;
    let s = 0;
    while (
      s < oldLine.length - p &&
      s < newLine.length - p &&
      oldLine[oldLine.length - 1 - s] === newLine[newLine.length - 1 - s]
    ) {
      s++;
    }
    const start = Math.max(0, p - DIFF_CONTEXT_CHARS);
    return {
      before: oldLine.slice(start, oldLine.length - s + DIFF_CONTEXT_CHARS),
      after: newLine.slice(start, newLine.length - s + DIFF_CONTEXT_CHARS),
    };
  }

  function progress(payload) {
    chrome.runtime.sendMessage({ type: 'pic:grammarly:progress', ...payload }).catch(() => {});
  }

  // ---------- commands ----------

  /**
   * Side panel is stateful (remembers the last tool) — force Grammarly /
   * Proofread. On a fresh doc the Grammarly panel is already open but renders
   * as a loading skeleton for ~15 s with no tab/pill buttons, so wait for the
   * Proofread tab before concluding the panel is on another tool (clicking
   * the rail button while the panel is open would toggle it closed).
   */
  // Both side panels stay mounted (recon §4): after the Humanizer pass the
  // Grammarly panel's Proofread tab is still in the DOM but hidden, which
  // is not "open". Visibility, not presence, decides.
  const visible = (el) => Boolean(el) && el.getClientRects().length > 0;
  const visibleProofreadTab = () => PIC.dom.queryAll(S.proofreadTab).find(visible) ?? null;

  async function prepare() {
    await PIC.dom.find(S.editor, { retries: 60, delay: 1000 });
    let tab = await PIC.wait
      .until(visibleProofreadTab, { retries: 60, delay: 500, desc: 'Proofread tab' })
      .catch(() => null);
    if (!tab) {
      log('prepare: Proofread tab not visible after 30 s — switching to the Grammarly panel');
      (await PIC.dom.find(S.railGrammarlyTool, { retries: 30, delay: 500 })).click();
      tab = await PIC.wait.until(visibleProofreadTab, { retries: 60, delay: 500, desc: 'Proofread tab' });
    }
    if (tab.getAttribute('aria-selected') !== 'true') {
      tab.click();
      await PIC.wait.settle();
    }
    return { ok: true };
  }

  /** Switch back to the Grammarly panel right away (no 30 s grace) — used between stages. */
  async function switchToProofread() {
    if (!visibleProofreadTab()) {
      (await PIC.dom.find(S.railGrammarlyTool, { retries: 30, delay: 500 })).click();
      await PIC.wait.until(visibleProofreadTab, { retries: 60, delay: 500, desc: 'Proofread tab' });
    }
    return prepare();
  }

  async function paste({ html }) {
    const editor = await PIC.dom.find(S.editor, { retries: 60, delay: 1000 });
    const existing = PIC.grammarly.readText().trim();
    if (existing) {
      throw new Error(`Refusing to paste into a non-empty document (${existing.length} chars present)`);
    }
    editor.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    const transfer = new DataTransfer();
    transfer.setData('text/html', html);
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );

    // Wait until the editor content stops growing.
    let last = -1;
    await PIC.wait.until(
      () => {
        const length = PIC.grammarly.readText().length;
        const stable = length > 0 && length === last;
        last = length;
        return stable;
      },
      { retries: 30, delay: 500, desc: 'pasted content to settle' },
    );
    return { ok: true, blockCount: PIC.grammarly.blocks().length, textLength: last };
  }

  /**
   * True once the panel has real pills + cards that agree (the skeleton has
   * neither). The score is deliberately not part of it: after an Accept the
   * header shows "--" for a while even though the list is back.
   */
  function panelLoaded() {
    const counts = pillCounts();
    if (counts.All === undefined || !PIC.dom.query(S.proofreadTab)) return false;
    const pressed = PIC.dom
      .queryAll(S.categoryPill)
      .find((b) => b.getAttribute('aria-pressed') === 'true');
    const m = /^(All|Grammar|Clarity|Delivery)/i.exec(pressed?.innerText.trim() ?? '');
    const name = m ? m[1] : 'All';
    const expected = counts[name] ?? 0;
    const rendered = cards().length;
    return counts.capped?.has(name) ? rendered >= expected : rendered === expected;
  }

  /**
   * Resolve once the panel is loaded and unchanged for `stablePolls`
   * consecutive polls. The score alone is not enough: it shows up while the
   * panel is still a skeleton, and after every Accept the card list
   * re-renders through an empty state.
   */
  async function waitPanelStable({ timeoutMs, stablePolls = ANALYSIS_STABLE_POLLS, delay = 1000 }) {
    const deadline = Date.now() + timeoutMs;
    let lastKey = null;
    let stable = 0;
    while (Date.now() < deadline) {
      const loaded = panelLoaded();
      const counts = pillCounts();
      const key = `${overallScore()}|${JSON.stringify({ ...counts, capped: undefined })}|${cards().length}`;
      if (loaded && key === lastKey) {
        stable++;
        if (stable >= stablePolls) return { score: overallScore(), counts };
      } else {
        stable = 0;
      }
      lastKey = key;
      await PIC.wait.sleep(delay);
    }
    throw new Error(`Grammarly panel did not settle within ${Math.round(timeoutMs / 1000)} s`);
  }

  async function waitAnalysis() {
    const deadline = Date.now() + ANALYSIS_TIMEOUT_MS;
    for (;;) {
      const { score, counts } = await waitPanelStable({ timeoutMs: deadline - Date.now() });
      if (score !== null) return { ok: true, score, counts };
      if (Date.now() > deadline) throw new Error('Grammarly analysis did not settle within 180 s');
      await PIC.wait.sleep(1000);
    }
  }

  async function selectPill(category) {
    const button = pill(category);
    if (!button) throw new Error(`Category pill "${category}" not found`);
    if (button.getAttribute('aria-pressed') !== 'true') {
      button.click();
      await PIC.wait.settle({ settleTime: 400 });
    }
    await waitPanelStable({ timeoutMs: 30_000, stablePolls: 2, delay: 500 });
  }

  /**
   * Accept suggestions category by category. Cards whose kind is denied (or
   * every card on a dry run) are left in place and skipped by identity
   * count, since skipped cards keep their position while accepted ones
   * vanish. Never touches the "Strengthen writing" tab.
   */
  async function accept({ policy, dryRun }, job = { accepted: [], seen: [] }) {
    const { accepted, seen } = job;
    let stuck = 0;
    let iterations = 0;

    // Accepting an edit can spawn a new suggestion in a category already
    // drained (a Clarity rewrite adding a Grammar comma), so repeat the
    // category passes until a whole pass accepts nothing.
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const acceptedBefore = accepted.length;
      for (const category of policy.acceptCategories) {
        await acceptCategory(category);
      }
      if (accepted.length === acceptedBefore) break;
    }
    await selectPill('All');
    return { ok: true, accepted, seen, stuck, counts: pillCounts() };

    async function acceptCategory(category) {
      await selectPill(category);
      const skipped = {}; // identity -> how many with that identity to skip
      let exhaustedChecks = 0;

      for (;;) {
        if (++iterations > MAX_ACCEPT_ITERATIONS) throw new Error('Accept loop runaway');
        // Every Accept triggers a re-analysis; on long docs the panel drops
        // back to its loading skeleton (no pills, no cards) for seconds.
        // Never read the list while it is in that state.
        if (!panelLoaded()) {
          await waitPanelStable({ timeoutMs: REANALYSIS_TIMEOUT_MS, stablePolls: 2, delay: 500 });
        }
        const seenNow = {};
        const card = cards().find((c) => {
          const id = cardIdentity(c);
          seenNow[id] = (seenNow[id] ?? 0) + 1;
          return seenNow[id] > (skipped[id] ?? 0);
        });
        if (!card) {
          // The panel can drop to its skeleton between the check above and
          // this read (re-analysis starts asynchronously after an Accept),
          // and a skeleton has no pills, so a missing pill must never count
          // as zero. Declare a category exhausted only when the panel is
          // loaded, stable, and its pill count agrees — checked twice.
          const counts = pillCounts();
          if (!panelLoaded() || counts[category] === undefined) {
            await waitPanelStable({ timeoutMs: REANALYSIS_TIMEOUT_MS, stablePolls: 2, delay: 500 });
            continue;
          }
          const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0);
          if (counts[category] <= skippedTotal) {
            if (++exhaustedChecks >= 2) break;
            await waitPanelStable({ timeoutMs: REANALYSIS_TIMEOUT_MS, stablePolls: 3, delay: 500 });
            continue;
          }
          exhaustedChecks = 0;
          await PIC.wait.sleep(1000);
          continue;
        }
        exhaustedChecks = 0;

        const identity = cardIdentity(card);
        const kind = card.querySelector('h3')?.textContent.trim() ?? '';
        const snippet = cardSnippet(card);
        const skip = () => {
          skipped[identity] = (skipped[identity] ?? 0) + 1;
        };

        if (dryRun) {
          seen.push({ category, kind, snippet });
          skip();
          continue;
        }
        if (policy.denyKinds.some((k) => k.toLowerCase() === kind.toLowerCase())) {
          seen.push({ category, kind, snippet, decision: 'denied' });
          skip();
          continue;
        }

        if (!expandedCard() || expandedCard() !== card) {
          card.click();
          await PIC.wait.until(() => expandedCard() === card, {
            retries: 20,
            delay: 250,
            desc: 'suggestion card to expand',
          });
        }
        const button = PIC.dom.query(S.acceptButton, card);
        if (!button) {
          seen.push({ category, kind, snippet, decision: 'no-accept-button' });
          skip();
          continue;
        }

        const countBefore = cards().length;
        const textBefore = PIC.grammarly.readText();
        button.click();
        let applied = true;
        try {
          await PIC.wait.until(() => cards().length < countBefore || !document.contains(card), {
            retries: 40,
            delay: 250,
            desc: 'suggestion to be applied',
          });
        } catch {
          applied = false;
        }
        if (!applied) {
          stuck++;
          seen.push({ category, kind, snippet, decision: 'stuck' });
          skip();
          if (stuck > MAX_STUCK_CARDS) throw new Error('Too many suggestions failed to apply');
          continue;
        }
        await PIC.wait.sleep(200);
        const diff = firstDiff(textBefore, PIC.grammarly.readText()) ?? {
          before: snippet,
          after: snippet,
        };
        accepted.push({ category, kind, snippet, ...diff });
        seen.push({ category, kind, snippet, decision: 'accepted' });
        progress({ accepted, done: accepted.length, remaining: cards().length });
      }
    }
  }

  async function extract() {
    const html = PIC.grammarly.readHtml();
    return {
      ok: true,
      html,
      text: PIC.grammarly.readText(),
      blockCount: PIC.grammarly.blocks().length,
      score: overallScore(),
    };
  }

  // The accept loop runs for minutes. It must NOT be awaited over one
  // chrome.tabs.sendMessage: the MV3 service worker can be restarted while
  // that response is pending, and a fresh worker then sees the item as
  // orphaned and moves on with whatever had been accepted. Instead the loop
  // runs detached here, its live state is readable via accept-status, and
  // the worker polls — which also keeps the worker alive.
  let acceptJob = null;

  async function startAccept({ policy, dryRun }) {
    if (acceptJob?.status === 'running') {
      return { ok: true, started: false, status: 'running' };
    }
    acceptJob = { status: 'running', startedAt: Date.now(), accepted: [], seen: [] };
    const job = acceptJob;
    accept({ policy, dryRun }, job)
      .then((result) => {
        job.status = 'done';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = err?.message ?? String(err);
        log('accept loop failed:', err);
      });
    return { ok: true, started: true, status: 'running' };
  }

  async function acceptStatus() {
    if (!acceptJob) return { ok: true, status: 'none' };
    return {
      ok: true,
      status: acceptJob.status,
      accepted: acceptJob.accepted,
      seen: acceptJob.seen,
      result: acceptJob.result,
      error: acceptJob.error,
      remaining: cards().length,
    };
  }

  // ---------- Humanizer (recon §4, pic-extension #21) ----------

  const HUMANIZER_ANALYSIS_TIMEOUT_MS = 180_000;
  const HUMANIZER_QUIET_MS = 45_000; // no annotation and no count after this long = nothing to rewrite
  const HUMANIZER_APPLY_TIMEOUT_MS = 40_000; // the first accept on a fresh doc took >20 s live
  const HUMANIZER_DRAIN_TIMEOUT_MS = 60_000; // count > 0 but nothing rendered: how long to keep trying
  const HUMANIZER_CLOSE_GRACE_MS = 5_000; // card closed after Accept: how long the block text may lag
  const HUMANIZER_EMPTY_POLLS = 4; // consecutive empty 1 s reads with no count before "drained"
  const MAX_HUMANIZER_ITERATIONS = 200;
  const MAX_HUMANIZER_OPEN_FAILURES = 3;

  function humanizerAnnotations() {
    return PIC.dom.queryAll(S.humanizerAnnotation);
  }

  function humanizerCard() {
    return PIC.dom.query(S.humanizerCardContent);
  }

  // Suggestion ids were numeric until ~2026-10; they are UUIDs now. The
  // annotation (`vbar_<id>`) and its open card (`vbar_card_<id>`) share it.
  function decorationId(el) {
    return /_([A-Za-z0-9-]+)$/.exec(el?.dataset.codaUiId ?? '')?.[1] ?? null;
  }

  function voiceCard(voice) {
    return PIC.dom.queryAll(S.humanizerVoiceCard).find((b) => b.innerText.trim().startsWith(voice));
  }

  // The voice card exists in the DOM while the Humanizer panel is hidden
  // behind the Grammarly one, and a hidden button still takes a click — so
  // the analysis ran, but the editor decorations render ONLY while the
  // Humanizer panel is the visible one. Seen live 2026-09-22 (article 246
  // ES: count 5 on the voice card, zero annotations, walk exited at once).
  function humanizerPanelVisible(voice) {
    return visible(voiceCard(voice));
  }

  async function showHumanizerPanel(voice) {
    if (humanizerPanelVisible(voice)) return;
    (await PIC.dom.find(S.railHumanizerTool, { retries: 30, delay: 500 })).click();
    await PIC.wait.until(() => humanizerPanelVisible(voice), {
      retries: 60,
      delay: 500,
      desc: `Humanizer panel with voice "${voice}"`,
    });
    await PIC.wait.sleep(500);
  }

  /** Numeric count on the voice card once analysis finished; null while analysing / when nothing is left. */
  function voiceCount(voice) {
    const last = voiceCard(voice)?.innerText.trim().split('\n').pop() ?? '';
    return /^\d+$/.test(last) ? Number(last) : null;
  }

  /** Index of the editor block a decoration sits beside (tops match within a few px). */
  function blockIndexFor(decoration) {
    const y = decoration.getBoundingClientRect().y;
    let best = -1;
    let bestDelta = Infinity;
    PIC.grammarly.blocks().forEach((block, i) => {
      const delta = Math.abs(block.getBoundingClientRect().y - y);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = i;
      }
    });
    return bestDelta <= 24 ? best : -1;
  }

  /**
   * The card's proposed text. Its innerText interleaves deleted and inserted
   * runs, so drop the deleted ones before reading it: since ~2026-10 a
   * replace is one diff span holding a struck-through delete run next to the
   * insert run; before that, pure-delete spans (aria-label "Undo delete, X,
   * this cannot…" with no ", insert,") stood alone.
   */
  function proposedText(card) {
    const clone = card.cloneNode(true);
    clone.querySelectorAll('button').forEach((b) => b.remove());
    clone.querySelectorAll(S.humanizerDiffDeleted.css).forEach((run) => run.remove());
    clone.querySelectorAll(S.humanizerDiffSpan.css).forEach((span) => {
      const label = span.getAttribute('aria-label') ?? '';
      if (/^Undo delete,/i.test(label) && !/, insert,/i.test(label)) span.remove();
    });
    const lines = clone.innerText.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.slice(1).join(' ');
  }

  /** A bare .click() on the annotation does nothing; the card opens on a real pointer sequence. */
  const squash = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

  function pointerClick(el) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, view: window, button: 0, pointerId: 1, isPrimary: true };
    for (const type of ['pointerover', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ev = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ev(type, { ...init, buttons: type.endsWith('down') ? 1 : 0 }));
    }
  }

  /**
   * Adopt a voice, then walk every block rewrite: accept unless a link's
   * text would not survive verbatim (the href goes with it — bold / italic
   * runs are allowed to go, operator decision 2026-09-22), dismiss on a dry
   * run. Accept never changed the block count live, and grammar-apply
   * refuses a paragraph-count change anyway.
   */
  async function humanize({ voice, dryRun }, job = { accepted: [], seen: [] }) {
    const { accepted, seen } = job;
    const blocks = PIC.grammarly.blocks;
    const text = (i) => PIC.grammarly.blockText(blocks()[i]).trim();

    await showHumanizerPanel(voice);
    const card = voiceCard(voice);
    if (card.getAttribute('aria-pressed') !== 'true') {
      card.click();
    }
    job.phase = 'analysing';
    // The count is the done signal; there is no spinner. A timeout with no
    // annotation means nothing to rewrite.
    const started = Date.now();
    while (voiceCount(voice) === null && Date.now() - started < HUMANIZER_ANALYSIS_TIMEOUT_MS) {
      const quiet = humanizerAnnotations().length === 0 && !humanizerCard();
      if (quiet && Date.now() - started > HUMANIZER_QUIET_MS) break;
      await PIC.wait.sleep(1000);
    }
    job.suggestions = voiceCount(voice) ?? humanizerAnnotations().length;
    job.phase = 'walking';

    let openFailures = 0;
    let stuck = 0;
    for (let i = 0; i < MAX_HUMANIZER_ITERATIONS; i++) {
      let open = humanizerCard();
      if (!open) {
        const annotation = await nextAnnotation(voice);
        if (!annotation) {
          if (humanizerCard()) continue; // a card opened on its own meanwhile
          break; // nothing left, and it stayed that way
        }
        pointerClick(annotation.querySelector('button') ?? annotation);
        try {
          open = await PIC.wait.until(() => humanizerCard(), { retries: 40, delay: 250, desc: 'rewrite card to open' });
        } catch {
          if (++openFailures >= MAX_HUMANIZER_OPEN_FAILURES) throw new Error('Humanizer card would not open');
          continue;
        }
        await PIC.wait.sleep(500);
      }
      const wrapper = PIC.dom.query(S.humanizerOpenCard);
      const id = decorationId(wrapper);
      const annotation = humanizerAnnotations().find((a) => decorationId(a) === id) ?? null;
      const index = annotation ? blockIndexFor(annotation) : -1;
      const title = open.innerText.split('\n')[0].trim();
      const before = index >= 0 ? text(index) : '';
      const proposed = proposedText(open);
      const record = { category: 'Humanizer', kind: title, snippet: before.slice(0, 160), blockIndex: index };

      const dismiss = async (decision) => {
        seen.push({ ...record, decision });
        const dismissButton = PIC.dom.query(S.dismissButton, open);
        if (!dismissButton) throw new Error(`Humanizer card "${title}" has no Dismiss button`);
        dismissButton.click();
        await PIC.wait.until(() => !document.contains(open), { retries: 40, delay: 250, desc: 'card to close' });
        await PIC.wait.sleep(300);
      };

      if (dryRun) {
        seen.push({ ...record, decision: 'seen', proposed: proposed.slice(0, 400) });
        await dismiss('seen');
        continue;
      }
      // Not every card is a rewrite: the "Strong resemblance to AI text"
      // notice (seen 2026-10-13) offers only "Launch AI Detector" / Dismiss.
      const acceptButton = PIC.dom.query(S.acceptButton, open);
      if (!acceptButton) {
        await dismiss('no-accept-button');
        continue;
      }
      if (index < 0) {
        await dismiss('no-block');
        continue;
      }
      // "Keep as is; already clear": the card proposes the paragraph
      // unchanged. Accepting it changes nothing, so waiting for the text to
      // change would burn the whole apply timeout per card and abort the item
      // on the fourth (seen live 2026-09-22, 8 such cards on one article).
      if (/^keep as is/i.test(title) || squash(proposed) === squash(before)) {
        await dismiss('no-change');
        continue;
      }
      const links = [...blocks()[index].querySelectorAll('a[href]')].map((a) => a.innerText.trim()).filter(Boolean);
      const lostLink = links.find((t) => !proposed.includes(t));
      if (lostLink) {
        await dismiss('link-at-risk');
        continue;
      }

      acceptButton.click();
      let applied = true;
      let closedAt = null;
      try {
        // The text changing is the real signal. The card now closes before
        // the block re-renders (seen 2026-10-13), so a closed card is read as
        // a no-op only once the text has stayed put for a grace period.
        await PIC.wait.until(() => {
          if (text(index) !== before) return true;
          if (document.contains(open)) return false;
          closedAt ??= Date.now();
          return Date.now() - closedAt > HUMANIZER_CLOSE_GRACE_MS;
        }, {
          retries: HUMANIZER_APPLY_TIMEOUT_MS / 250,
          delay: 250,
          desc: 'rewrite to apply',
        });
      } catch {
        applied = false;
      }
      if (applied && text(index) === before) {
        seen.push({ ...record, decision: 'no-change' });
        await PIC.wait.sleep(500);
        continue;
      }
      if (!applied) {
        if (++stuck > MAX_STUCK_CARDS) throw new Error('Too many rewrites failed to apply');
        seen.push({ ...record, decision: 'stuck' });
        if (document.contains(open)) await dismiss('stuck');
        continue;
      }
      const after = text(index);
      const survivingLinks = [...blocks()[index].querySelectorAll('a[href]')].map((a) => a.innerText.trim());
      const decision = links.length === survivingLinks.length ? 'accepted' : 'accepted-link-lost';
      accepted.push({ ...record, before, after });
      seen.push({ ...record, decision });
      job.remaining = humanizerAnnotations().length;
      // The next card auto-opens after an accept; give it a beat.
      await PIC.wait.sleep(800);
    }
    return { ok: true, accepted, seen, suggestions: job.suggestions };
  }

  /**
   * The next annotation to open, or null once the document is really
   * drained. An empty read is not proof of that: decorations re-render after
   * every accept, they render only while the Humanizer panel is visible, and
   * the voice re-analyses the edited text and can post a fresh count. So an
   * empty list is re-read for a few seconds, the panel is brought back if it
   * slipped behind, and while the voice card still shows a count > 0 the
   * wait is extended (bounded) before giving up.
   */
  async function nextAnnotation(voice) {
    const deadline = Date.now() + HUMANIZER_DRAIN_TIMEOUT_MS;
    let emptyPolls = 0;
    while (Date.now() < deadline) {
      const card = humanizerCard();
      if (card) return null; // caller re-reads the open card
      const [annotation] = humanizerAnnotations();
      if (annotation) return annotation;
      if (!humanizerPanelVisible(voice)) {
        await showHumanizerPanel(voice);
        continue;
      }
      const count = voiceCount(voice);
      emptyPolls++;
      if ((count === null || count === 0) && emptyPolls >= HUMANIZER_EMPTY_POLLS) return null;
      await PIC.wait.sleep(1000);
    }
    return null;
  }

  let humanizeJob = null;

  async function startHumanize({ voice, dryRun }) {
    if (humanizeJob?.status === 'running') return { ok: true, started: false, status: 'running' };
    humanizeJob = { status: 'running', startedAt: Date.now(), accepted: [], seen: [] };
    const job = humanizeJob;
    humanize({ voice, dryRun }, job)
      .then((result) => {
        job.status = 'done';
        job.result = result;
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = err?.message ?? String(err);
        log('humanize loop failed:', err);
      });
    return { ok: true, started: true, status: 'running' };
  }

  async function humanizeStatus() {
    if (!humanizeJob) return { ok: true, status: 'none' };
    return {
      ok: true,
      status: humanizeJob.status,
      phase: humanizeJob.phase,
      accepted: humanizeJob.accepted,
      seen: humanizeJob.seen,
      result: humanizeJob.result,
      error: humanizeJob.error,
      remaining: humanizerAnnotations().length,
    };
  }

  // ---------- message router ----------

  const handlers = {
    'pic:grammarly:ping': async () => ({ ok: true }),
    'pic:grammarly:prepare': prepare,
    'pic:grammarly:switch-to-proofread': switchToProofread,
    'pic:grammarly:paste': paste,
    'pic:grammarly:wait-analysis': waitAnalysis,
    'pic:grammarly:accept': startAccept,
    'pic:grammarly:accept-status': acceptStatus,
    'pic:grammarly:humanize': startHumanize,
    'pic:grammarly:humanize-status': humanizeStatus,
    'pic:grammarly:extract': extract,
  };
  // Exposed for live debugging from DevTools (`PIC.grammarlyCommands[...]()`).
  PIC.grammarlyCommands = handlers;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const handler = handlers[message?.type];
    if (!handler) return undefined;
    log('command received:', message.type);
    handler(message)
      .then(sendResponse)
      .catch((err) => {
        log('command failed:', message.type, err);
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true; // async response
  });
})();
