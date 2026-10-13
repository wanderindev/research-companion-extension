// claude.ai automation entry point. Executes commands from the service
// worker: compose/send a research prompt (M3) and check completion /
// extract the artifact via the internal API (M4).
// Flow details: docs/PLAN.md; selectors: selectors.js + docs/claude-ai-recon.md.

(() => {
  // Guard against double-injection (declarative + programmatic fallback):
  // a second listener would race sendResponse.
  if (window.__picClaudeLoaded) return;
  window.__picClaudeLoaded = true;

  const PIC = (window.PIC ??= {});
  const S = PIC.SELECTORS;
  const log = (...args) => console.info('[pic]', ...args);

  log('claude content script ready on', location.pathname);

  // ---------- compose ----------

  // The composer can take a while to mount on cold loads (the content
  // script is ready long before React paints) — gate every compose on a
  // generous wait for its anchor element.
  async function waitForComposer() {
    await PIC.dom.find(S.chatInput, { retries: 60, delay: 1000 });
  }

  async function ensureChatMode() {
    // The Chat/Cowork toggle is optional: some sessions/layouts don't
    // render it, and its absence means the composer is already plain chat.
    const radio = await PIC.dom.find(S.chatModeRadio, { retries: 6, optional: true });
    if (!radio) {
      log('Chat/Cowork toggle not present — assuming Chat mode');
      return;
    }
    if (radio.getAttribute('aria-checked') !== 'true') {
      radio.click();
      await PIC.wait.settle();
    }
  }

  async function ensureModelAndEffort() {
    let button = await PIC.dom.find(S.modelSelector);
    if (!/Sonnet/i.test(button.getAttribute('aria-label') ?? '')) {
      button.click();
      const option = await PIC.dom.find(S.modelOptionSonnet, { retries: 10 });
      option.click();
      await PIC.wait.settle();
    }
    button = await PIC.dom.find(S.modelSelector);
    if (!/Medium/i.test(button.getAttribute('aria-label') ?? '')) {
      button.click();
      const trigger = await PIC.dom.find(S.effortMenuTrigger, { retries: 10 });
      trigger.click();
      const option = await PIC.dom.find(S.effortOptionMedium, { retries: 10 });
      option.click();
      await PIC.wait.settle();
      PIC.dom.escape();
    }
    button = await PIC.dom.find(S.modelSelector);
    const label = button.getAttribute('aria-label') ?? '';
    if (!/Sonnet/i.test(label) || !/Medium/i.test(label)) {
      throw new Error(`Could not select Sonnet/Medium (model button reads "${label}")`);
    }
  }

  async function enableResearch() {
    const plus = await PIC.dom.find(S.plusMenu);
    plus.click();
    const toggle = await PIC.dom.find(S.researchToggle, { retries: 10 });
    if (toggle.getAttribute('aria-checked') !== 'true') {
      toggle.click();
      await PIC.wait.settle();
    }
    PIC.dom.escape();
    await PIC.wait.sleep(300);
  }

  async function insertPrompt(prompt) {
    const input = await PIC.dom.find(S.chatInput);
    PIC.dom.insertText(input, prompt);
    // The send button appearing is the proof the editor state registered.
    await PIC.dom.find(S.sendButton, { retries: 10 });
  }

  async function waitForConversationUuid() {
    return PIC.wait.until(
      () => /^\/chat\/([0-9a-f-]{36})/.exec(location.pathname)?.[1],
      { retries: 60, delay: 500, desc: 'conversation URL after send' },
    );
  }

  // Connectors modal (docs/claude-ai-recon.md §2). Optional: accounts
  // without connectors never see it.
  async function dismissConnectorsModal() {
    const dialog = await PIC.dom.find(S.connectorsDialog, {
      retries: 20,
      delay: 1000,
      optional: true,
    });
    if (!dialog) return { appeared: false };

    (await PIC.dom.find(S.disableAllTools, { root: dialog, retries: 5 })).click();
    await PIC.wait.settle();

    // Belt and braces: verify every connector switch is off; re-toggle
    // stragglers via their row button (the switch spans are inert).
    // Switches inside a <label> ("Always allow…") are handled separately.
    for (let attempt = 0; attempt < 3; attempt++) {
      const stillOn = PIC.dom
        .queryAll(S.connectorSwitch, dialog)
        .filter((s) => s.getAttribute('aria-checked') === 'true' && !s.closest('label'));
      if (stillOn.length === 0) break;
      for (const s of stillOn) s.closest('button')?.click();
      await PIC.wait.settle();
    }

    // "Always allow N selected connectors" must stay OFF — it would make
    // this modal (our safety gate) stop appearing on future runs.
    const alwaysAllow = PIC.dom
      .queryAll(S.connectorSwitch, dialog)
      .find((s) => s.closest('label'));
    if (alwaysAllow?.getAttribute('aria-checked') === 'true') {
      alwaysAllow.click();
      await PIC.wait.settle();
    }

    (await PIC.dom.find(S.modalConfirm, { root: dialog, retries: 5 })).click();
    await PIC.wait.until(() => !document.contains(dialog), {
      retries: 20,
      delay: 500,
      desc: 'connectors modal to close',
    });
    return { appeared: true };
  }

  async function compose({ prompt, dryRun }) {
    if (location.pathname !== '/new') {
      throw new Error(`compose expects claude.ai/new (got ${location.pathname})`);
    }
    log('compose: waiting for the composer to render');
    await waitForComposer();
    log('compose: ensuring Chat mode');
    await ensureChatMode();
    log('compose: ensuring Sonnet / medium effort');
    await ensureModelAndEffort();
    log('compose: enabling Research');
    await enableResearch();
    log('compose: inserting prompt', `(${prompt.length} chars)`);
    await insertPrompt(prompt);

    if (dryRun) {
      log('compose: dry run — stopping before send');
      return { ok: true, dryRun: true };
    }

    log('compose: sending');
    (await PIC.dom.find(S.sendButton)).click();
    const conversationUuid = await waitForConversationUuid();
    log('compose: conversation', conversationUuid, '— watching for connectors modal');
    const modal = await dismissConnectorsModal();
    log('compose: done (connectors modal appeared:', modal.appeared, ')');
    return { ok: true, conversationUuid, connectorsModalAppeared: modal.appeared };
  }

  // ---------- completion check ----------

  async function check({ conversationUuid }) {
    const conversation = await PIC.claudeApi.conversation(conversationUuid);
    return { ok: true, ...PIC.claudeApi.evaluate(conversation) };
  }

  // ---------- message router ----------

  const handlers = {
    'pic:claude:ping': async () => ({ ok: true }),
    'pic:claude:compose': compose,
    'pic:claude:check': check,
  };

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
