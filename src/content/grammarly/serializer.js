// Reads the Grammarly editor DOM back out as article HTML (and plain text).
// Grammarly's Slate editor keeps stable semantic classes on every block and
// inline span (`kr-h2`, `kr-paragraph`, `kr-listitem`, `kr-bold`, …), so the
// corrected document can be serialized without the clipboard — a synthetic
// `copy` event yields nothing and navigator.clipboard.read() needs a
// permission prompt. STRICT by design: any node we do not recognise throws
// with its outerHTML, never a silent drop, because the output is written
// back into the article. Article bodies in PIC use headings, paragraphs,
// bold, italic and links only (prod survey 2026-09-20); lists and quotes are
// handled defensively.

(() => {
  const PIC = (window.PIC ??= {});
  const S = () => PIC.GRAMMARLY_SELECTORS;

  const IGNORED_NODE = '[data-editable-ignore-node]';
  const HIDDEN_SPAN = 'kr-hidden-child';
  // Word joiner / zero-width chars Grammarly pads links with.
  const ZERO_WIDTH = /[\u2060\u200b\ufeff]/g;

  const escapeText = (s) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escapeAttr = (s) => escapeText(s).replace(/"/g, '&quot;');

  function editor() {
    const el = PIC.dom.query(S().editor);
    if (!el) throw new Error('Grammarly editor not found');
    return el;
  }

  function blocks() {
    return [...editor().children];
  }

  function blockText(block) {
    const clone = block.cloneNode(true);
    clone.querySelectorAll(`${IGNORED_NODE}, .${HIDDEN_SPAN}`).forEach((n) => n.remove());
    return clone.textContent.replace(ZERO_WIDTH, '');
  }

  function readText() {
    return blocks().map(blockText).join('\n');
  }

  function inlineHtml(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.nodeValue.replace(ZERO_WIDTH, '');
        out += escapeText(text).replace(/\n/g, '<br>');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      if (child.matches(IGNORED_NODE) || child.classList.contains(HIDDEN_SPAN)) continue;

      const tag = child.tagName;
      if (tag === 'A') {
        const href = child.getAttribute('href') ?? '';
        out += `<a href="${escapeAttr(href)}">${inlineHtml(child)}</a>`;
        continue;
      }
      if (tag === 'BR') {
        out += '<br>';
        continue;
      }
      if (tag === 'SPAN') {
        const cls = child.classList;
        const unsupported = ['kr-underline', 'kr-line-through'].filter((c) => cls.contains(c));
        if (unsupported.length) {
          throw new Error(`Unsupported inline formatting ${unsupported.join(',')}: ${child.outerHTML.slice(0, 200)}`);
        }
        let inner = inlineHtml(child);
        if (cls.contains('kr-mono')) inner = `<code>${inner}</code>`;
        if (cls.contains('kr-italic')) inner = `<em>${inner}</em>`;
        if (cls.contains('kr-bold')) inner = `<strong>${inner}</strong>`;
        out += inner;
        continue;
      }
      // Structural wrappers Grammarly puts around links / objects.
      if (tag === 'DIV' || tag === 'VAR') {
        out += inlineHtml(child);
        continue;
      }
      throw new Error(`Unsupported inline node <${tag}>: ${child.outerHTML.slice(0, 200)}`);
    }
    return out;
  }

  function readHtml() {
    const parts = [];
    let openList = null; // 'ul' | 'ol'

    const closeList = () => {
      if (openList) {
        parts.push(`</${openList}>`);
        openList = null;
      }
    };

    for (const block of blocks()) {
      const cls = block.classList;
      const tag = block.tagName;

      if (cls.contains('kr-listitem')) {
        if (parseFloat(getComputedStyle(block).paddingLeft) > 28) {
          throw new Error(`Unsupported nested list item: ${block.outerHTML.slice(0, 200)}`);
        }
        const listTag = cls.contains('kr-olist') ? 'ol' : 'ul';
        if (openList !== listTag) {
          closeList();
          parts.push(`<${listTag}>`);
          openList = listTag;
        }
        parts.push(`<li>${inlineHtml(block)}</li>`);
        continue;
      }
      closeList();

      if (/^H[1-6]$/.test(tag)) {
        parts.push(`<${tag.toLowerCase()}>${inlineHtml(block)}</${tag.toLowerCase()}>`);
      } else if (tag === 'BLOCKQUOTE') {
        parts.push(`<blockquote><p>${inlineHtml(block)}</p></blockquote>`);
      } else if (cls.contains('kr-paragraph')) {
        const html = inlineHtml(block);
        // A blank paragraph is a blank line — markdown has no such block.
        if (html.replace(/<br>/g, '').trim() === '') continue;
        parts.push(`<p>${html}</p>`);
      } else {
        throw new Error(
          `Unsupported block <${tag} class="${[...cls].filter((c) => c.startsWith('kr-')).join(' ')}">: ` +
            block.outerHTML.slice(0, 200),
        );
      }
    }
    closeList();
    return parts.join('\n');
  }

  PIC.grammarly = { blocks, blockText, readText, readHtml };
})();
