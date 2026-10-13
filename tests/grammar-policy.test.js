import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// grammar-run.js imports chrome-bound modules, so the policy block is
// evaluated on its own: everything from SHARED_DENY_KINDS to policyFor's end.
const source = readFileSync(new URL('../src/background/grammar-run.js', import.meta.url), 'utf8');
const start = source.indexOf('const SHARED_DENY_KINDS');
const end = source.indexOf('const contentTimeout');
const { DEFAULT_POLICY, policyFor, shouldStamp } = await import(
  `data:text/javascript;base64,${Buffer.from(source.slice(start, end)).toString('base64')}`
);

test('both languages accept Grammar, Clarity and Delivery and run the Humanizer with the Everyday Voice', () => {
  for (const lang of ['en', 'es']) {
    assert.deepEqual(DEFAULT_POLICY[lang].acceptCategories, ['Grammar', 'Clarity', 'Delivery']);
    assert.deepEqual(DEFAULT_POLICY[lang].humanizer, { enabled: true, voice: 'The Everyday Voice' });
    // Inverted the article's own punchline once; stays a human call everywhere.
    assert.ok(DEFAULT_POLICY[lang].denyKinds.includes('Check wording'));
  }
  // The two languages' policies must not share one array.
  assert.notEqual(DEFAULT_POLICY.en.acceptCategories, DEFAULT_POLICY.es.acceptCategories);
});

test('Spanish keeps its extra denials; English accepts sentence rewrites', () => {
  for (const kind of ['Rewrite the sentence', 'Fix capitalization', 'Correct the mistake']) {
    assert.ok(DEFAULT_POLICY.es.denyKinds.includes(kind), kind);
    assert.ok(!DEFAULT_POLICY.en.denyKinds.includes(kind), kind);
  }
});

test('policyFor honours a legacy flat override for both languages and a per-language one', () => {
  assert.deepEqual(policyFor('es', { denyKinds: ['X'] }).denyKinds, ['X']);
  assert.deepEqual(policyFor('en', { es: { humanizer: { enabled: false } } }).humanizer.enabled, true);
  assert.deepEqual(policyFor('es', { es: { humanizer: { enabled: false } } }).humanizer.enabled, false);
  assert.deepEqual(policyFor('fr').denyKinds, policyFor('en').denyKinds);
});

test('shouldStamp gates on the per-language score bar and stamps when there is no score', () => {
  const policy = policyFor('en');
  assert.equal(policy.minScoreToStamp, 97);
  assert.equal(shouldStamp(policy, 96), false);
  assert.equal(shouldStamp(policy, 97), true);
  assert.equal(shouldStamp(policy, null), true);
  assert.equal(shouldStamp({ ...policy, minScoreToStamp: 0 }, 50), true);
  assert.equal(shouldStamp(policyFor('es', { es: { minScoreToStamp: 90 } }), 91), true);
});
