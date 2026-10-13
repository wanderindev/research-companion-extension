// Pre-paste guards for the grammar run. Dependency-free (no chrome.*) so the
// rules can be unit-tested under `node --test` without the worker.

// Grammarly's web editor has three heading levels: an <h4> pasted in renders
// and reads back as <h3> (verified live 2026-09-20, docs/grammarly-recon.md
// §2), and the serializer cannot tell a collapsed heading from a real one, so
// a run on such a body would silently write it back one level up. h1 is
// refused too: the article title is stored separately, so a body should never
// carry one — the operator's 2026-09-21 audit found a single h1, in an
// unfinished article, and confirmed the exclusion (pic-extension #28).
export const REFUSED_HEADING_LEVELS = [1, 4, 5, 6];

const HEADING_TAG = /<h([1-6])(?=[\s>/])/gi;

/**
 * Heading levels present in `html` that the Grammarly round trip cannot
 * preserve, as sorted tag names (e.g. ['h1', 'h4']); empty when safe.
 */
export function findRefusedHeadings(html) {
  const found = new Set();
  for (const match of String(html ?? '').matchAll(HEADING_TAG)) {
    const level = Number(match[1]);
    if (REFUSED_HEADING_LEVELS.includes(level)) found.add(`h${level}`);
  }
  return [...found].sort();
}

/** Human-readable refusal for the run's itemResults / popup line. */
export function headingRefusalReason(articleId, language, headings) {
  return (
    `Article ${articleId} ${language.toUpperCase()} body contains ${headings.join(', ')} ` +
    "heading(s) that Grammarly's editor would collapse (it supports h1–h3 only; h4+ read back as h3). " +
    'Fix the heading level in the admin editor and re-run.'
  );
}
