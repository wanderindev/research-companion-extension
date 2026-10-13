// DOM helpers for the claude.ai content scripts. All lookups go through the
// selector registry specs ({css, text?, description}) so failures log a
// human-readable description.

(() => {
  const PIC = (window.PIC ??= {});

  PIC.dom = {
    // claude.ai (since ~2026-09) renders menu/radio icons as icon-font glyphs
    // in the Unicode Private Use Area (U+E000–U+F8FF) *inside* the element's
    // text — e.g. the Research item's textContent is "\uE0D0Research" and a
    // selected item carries a trailing check glyph. Anchored regexes like
    // /^research$/ silently stop matching, so strip PUA and zero-width
    // characters before testing.
    visibleText(el) {
      return el.textContent.replace(/[\uE000-\uF8FF\u200B-\u200D\uFEFF]/g, '').trim();
    },

    matchesSpec(el, spec) {
      return !spec.text || spec.text.test(PIC.dom.visibleText(el));
    },

    queryAll(spec, root = document) {
      return [...root.querySelectorAll(spec.css)].filter((el) => PIC.dom.matchesSpec(el, spec));
    },

    query(spec, root = document) {
      return PIC.dom.queryAll(spec, root)[0] ?? null;
    },

    /** Retrying finder. Throws with the spec description unless `optional`. */
    async find(spec, { root = document, retries = 20, delay = 500, optional = false } = {}) {
      for (let attempt = 0; attempt < retries; attempt++) {
        const el = PIC.dom.query(spec, root);
        if (el) return el;
        await PIC.wait.sleep(delay);
      }
      if (optional) return null;
      throw new Error(`Element not found: ${spec.description} (${spec.css})`);
    },

    /**
     * Replace the ProseMirror composer content. execCommand('insertText')
     * is required — it drives the editor's real input pipeline so React
     * state updates (plain DOM writes leave the app thinking it's empty).
     */
    insertText(el, text) {
      el.focus();
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, text);
    },

    /** Close any open Base UI menu/popover. */
    escape() {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    },
  };
})();
