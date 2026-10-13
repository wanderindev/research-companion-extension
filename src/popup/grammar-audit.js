// Pure formatting helpers for the popup's per-item grammar audit (#23).
// No DOM, no chrome.* — unit-tested under `node --test`.

export const GRAMMAR_STATUS_LABELS = {
  applied: 'applied',
  stamped: 'clean (stamped)',
  applied_unstamped: 'applied, score below bar (still queued)',
  unstamped: 'unchanged, score below bar (still queued)',
  dry_run_ok: 'dry run OK',
  dry_run_drift: 'dry run: round trip DRIFTED',
  skipped: 'skipped (article changed)',
  refused: 'refused',
};

/** The one-line summary for an item: status, counts, score, verdict-gate counts, error. */
export function itemHeadline(r) {
  const parts = [`#${r.articleId} ${String(r.language ?? '').toUpperCase()}: ${GRAMMAR_STATUS_LABELS[r.status] ?? r.status}`];
  if (r.accepted) parts.push(`${r.accepted} accepted${r.humanized ? ` (${r.humanized} rewrites)` : ''}`);
  if (r.revertedCount) parts.push(`${r.revertedCount} reverted by Sonnet`);
  if (r.reviewCount) parts.push(`${r.reviewCount} to review`);
  let line = parts.join(', ');
  if (r.scoreBefore != null && r.scoreAfter != null) line += ` ${r.scoreBefore}→${r.scoreAfter}`;
  if (r.resumed) line += ' (resumed)';
  if (r.error) line += ` — ${r.error}`;
  return line;
}

/**
 * Group the cards the loop looked at by decision, then by kind, with the
 * first few snippets as examples. Order: denied, stuck, no-accept-button,
 * seen (dry run), accepted — so what was *held back* reads first.
 */
export function groupSeen(seenItems, { examples = 3 } = {}) {
  const order = ['denied', 'stuck', 'no-accept-button', 'seen', 'accepted'];
  const groups = new Map();
  for (const item of seenItems ?? []) {
    const decision = item.decision ?? 'seen';
    const key = `${decision}\u0000${item.category ?? ''}\u0000${item.kind ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { decision, category: item.category ?? '', kind: item.kind ?? '', count: 0, snippets: [] };
      groups.set(key, g);
    }
    g.count++;
    if (g.snippets.length < examples && item.snippet) g.snippets.push(item.snippet);
  }
  const rank = (d) => (order.includes(d) ? order.indexOf(d) : order.length);
  return [...groups.values()].sort(
    (a, b) => rank(a.decision) - rank(b.decision) || b.count - a.count || a.kind.localeCompare(b.kind),
  );
}

export const DECISION_LABELS = {
  denied: 'held back by policy',
  'link-at-risk': 'dismissed (link text would change)',
  'accepted-link-lost': 'accepted but a link was lost',
  'no-block': 'dismissed (block not found)',
  'no-change': 'no-op card (keep as is)',
  stuck: 'did not apply',
  'no-accept-button': 'no Accept button',
  seen: 'seen (dry run)',
  accepted: 'accepted',
};

/** Run state as pretty JSON for the clipboard, with the bulky per-item fields kept. */
export function runStateJson(run) {
  return JSON.stringify(run ?? {}, null, 2);
}
