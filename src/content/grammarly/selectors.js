// Centralized coda.grammarly.com selector registry — the ONLY place Grammarly
// selectors live. Captured live 2026-09-20; see docs/grammarly-recon.md and
// keep both in sync. Each spec: { css, text?, description }. Grammarly's
// hashed classes (`_root_hblmT_root`, `zNvSLmyz`) churn on their deploys —
// anchor on data-testid / role / aria / the semantic `kr-*` editor classes.

(() => {
  const PIC = (window.PIC ??= {});

  PIC.GRAMMARLY_SELECTORS = {
    editor: {
      css: 'div[contenteditable="true"][data-editable-id="root"]',
      description: 'document editor (Slate contenteditable, role=textbox)',
    },
    railGrammarlyTool: {
      css: 'button[aria-label="Grammarly"]',
      description: 'right-rail button that opens the Grammarly (proofread) side panel',
    },
    proofreadTab: {
      css: 'button[role="tab"]',
      text: /^proofread$/i,
      description: 'Proofread tab in the Grammarly side panel',
    },
    categoryPill: {
      css: 'button[aria-pressed]',
      description: 'category filter pill (All / Grammar / Clarity / Delivery, text carries the count)',
    },
    suggestionCard: {
      css: '[data-testid="feed-card"]',
      description: 'suggestion card in the side panel',
    },
    suggestionCardExpanded: {
      css: '[data-testid="feed-card"][class*="isExpanded"]',
      description: 'the one expanded suggestion card (exposes Accept / Dismiss)',
    },
    acceptButton: {
      css: 'button',
      text: /^accept$/i,
      description: 'Accept button inside the expanded suggestion card',
    },
    dismissButton: {
      css: 'button',
      text: /^dismiss$/i,
      description: 'Dismiss button inside the expanded suggestion card',
    },
    // Humanizer (recon §4). Both side panels stay in the DOM; these never
    // overlap with the proofread selectors above.
    railHumanizerTool: {
      css: 'button[aria-label="Humanizer"]',
      description: 'right-rail button that opens the Humanizer side panel',
    },
    humanizerVoiceCard: {
      css: 'button[aria-pressed]',
      description: '"Adopt a voice" card (text starts with the voice name; last line is the count once analysed)',
    },
    humanizerAnnotation: {
      css: '[data-coda-ui-id^="ai-editor-text-decoration#humanizer-vbar_"]:not([data-coda-ui-id*="vbar_card_"])',
      description: 'margin annotation for one block rewrite (its y matches the block; holds a button titled with the rewrite)',
    },
    humanizerOpenCard: {
      css: '[data-coda-ui-id^="ai-editor-text-decoration#humanizer-vbar_card_"]',
      description: 'wrapper of the open rewrite card (id suffix matches its annotation)',
    },
    humanizerCardContent: {
      css: '[data-testid="card-content"]',
      description: 'rewrite card: title line, proposed block text with revertible-rewrite-diff spans, Accept / Dismiss',
    },
    humanizerDiffSpan: {
      css: '[data-testid="revertible-rewrite-diff"]',
      description: 'one change inside the card; aria-label "Undo delete, <old>, insert, <new>, …"',
    },
    humanizerDiffDeleted: {
      css: '[data-testid="revertible-rewrite-diff"] [class*="_delete_"]',
      description: 'struck-through deleted run inside a change (sits next to its `_insert_` run)',
    },
    overallScore: {
      css: 'button, div, span',
      text: /^(\d{1,3}|--|–)\s*overall score$/i,
      description: 'header "Overall score" readout (-- while analysing)',
    },
  };
})();
