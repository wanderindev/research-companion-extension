// Centralized claude.ai selector registry — the ONLY place selectors live.
// Captured live; see docs/claude-ai-recon.md and keep both in sync.
// Each spec: { css, text?, description }. `text` is a regex tested against
// the element's trimmed textContent (claude.ai element ids are runtime-
// generated and must never be used).

(() => {
  const PIC = (window.PIC ??= {});

  PIC.SELECTORS = {
    chatInput: {
      css: '[data-testid="chat-input"]',
      description: 'composer prompt input (ProseMirror contenteditable)',
    },
    chatModeRadio: {
      css: 'span[role="radio"]',
      text: /^chat$/i,
      description: 'Chat mode radio in the Chat/Cowork toggle',
    },
    modelSelector: {
      css: '[data-testid="model-selector-dropdown"]',
      description: 'model selector button (aria-label mirrors selection)',
    },
    modelOptionSonnet: {
      css: '[role="menuitemradio"]',
      text: /^sonnet 5/i,
      description: 'Sonnet 5 option in the model menu',
    },
    effortMenuTrigger: {
      css: '[data-testid="effort-menu-trigger"]',
      description: 'effort submenu trigger in the model menu',
    },
    effortOptionMedium: {
      css: '[data-testid="effort-option-medium"]',
      description: 'medium effort option',
    },
    plusMenu: {
      css: 'button[aria-label="Add files, connectors, and more"]',
      description: '"+" tools menu button',
    },
    researchToggle: {
      // data-testid landed 2026-09; the role+text form is kept as a fallback
      // (text is matched after icon-font glyphs are stripped — see dom-utils).
      css: '[data-testid="add-menu-research"], [role="menuitemcheckbox"]',
      text: /^research$/i,
      description: 'Research toggle in the "+" menu',
    },
    sendButton: {
      css: 'button[aria-label="Send message"]',
      description: 'send button (only exists once the input has content)',
    },
    connectorsDialog: {
      css: '[role="dialog"]',
      text: /enable connectors for claude to use in research/i,
      description: 'post-send connectors modal',
    },
    disableAllTools: {
      css: 'span[data-cds="TextLink"][role="button"]',
      text: /^disable all tools$/i,
      description: '"Disable all tools" link in the connectors modal (a span, not a button)',
    },
    connectorSwitch: {
      css: 'span[role="switch"][data-cds="Switch"]',
      description: 'connector on/off switch (decorative/inert — click the row button)',
    },
    modalConfirm: {
      // aria-keyshortcuts="Enter" disappeared 2026-09-21; the button is now a
      // plain data-cds Button whose only stable signal is its "Confirm" label.
      // Always searched with root = the connectors dialog.
      css: 'button[aria-keyshortcuts="Enter"], button[data-cds="Button"]',
      text: /^confirm$/i,
      description: 'Confirm button in the connectors modal',
    },
  };
})();
