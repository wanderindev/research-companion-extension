import assert from 'node:assert/strict';
import { test } from 'node:test';

import { groupSeen, itemHeadline, runStateJson } from '../src/popup/grammar-audit.js';

test('headline carries status, counts, verdict-gate counts, score and error', () => {
  const line = itemHeadline({
    articleId: 245,
    language: 'en',
    status: 'applied',
    accepted: 7,
    revertedCount: 1,
    reviewCount: 2,
    scoreBefore: 88,
    scoreAfter: 96,
  });
  assert.equal(line, '#245 EN: applied, 7 accepted, 1 reverted by Sonnet, 2 to review 88→96');

  const refused = itemHeadline({ articleId: 3, language: 'es', status: 'refused', accepted: 0, error: 'h4 present' });
  assert.equal(refused, '#3 ES: refused — h4 present');
});

test('headline shows the Humanizer rewrite share of the accepted count', () => {
  assert.equal(
    itemHeadline({ articleId: 9, language: 'es', status: 'applied', accepted: 5, humanized: 2 }),
    '#9 ES: applied, 5 accepted (2 rewrites)',
  );
});

test('headline omits zero counts and unknown statuses fall through verbatim', () => {
  assert.equal(itemHeadline({ articleId: 1, language: 'en', status: 'weird', accepted: 0, reviewCount: 0 }), '#1 EN: weird');
});

test('groupSeen groups by decision then kind, held-back first, with bounded examples', () => {
  const seen = [
    { category: 'Grammar', kind: 'Add a comma', snippet: 'a', decision: 'accepted' },
    { category: 'Grammar', kind: 'Fix capitalization', snippet: 'ruta', decision: 'denied' },
    { category: 'Grammar', kind: 'Fix capitalization', snippet: 'plata', decision: 'denied' },
    { category: 'Grammar', kind: 'Correct the mistake', snippet: 'la Vieja', decision: 'denied' },
    { category: 'Grammar', kind: 'Add a comma', snippet: 'b', decision: 'stuck' },
    { category: 'Grammar', kind: 'Fix capitalization', snippet: 'x' }, // dry run: no decision
  ];
  const groups = groupSeen(seen, { examples: 1 });
  assert.deepEqual(
    groups.map((g) => [g.decision, g.kind, g.count, g.snippets]),
    [
      ['denied', 'Fix capitalization', 2, ['ruta']],
      ['denied', 'Correct the mistake', 1, ['la Vieja']],
      ['stuck', 'Add a comma', 1, ['b']],
      ['seen', 'Fix capitalization', 1, ['x']],
      ['accepted', 'Add a comma', 1, ['a']],
    ],
  );
  assert.deepEqual(groupSeen(undefined), []);
});

test('runStateJson is pretty JSON and tolerates an empty run', () => {
  assert.equal(runStateJson(null), '{}');
  assert.match(runStateJson({ phase: 'done', itemResults: [{ articleId: 1 }] }), /"articleId": 1/);
});
