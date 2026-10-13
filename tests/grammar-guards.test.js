import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findRefusedHeadings, headingRefusalReason } from '../src/background/grammar-guards.js';

test('a body with only h2/h3 headings proceeds', () => {
  const html = '<h2>Part 1</h2><p>Text</p><h3 class="x">Sub</h3><p>More <b>text</b></p>';
  assert.deepEqual(findRefusedHeadings(html), []);
});

test('a body with an h4 is refused, naming the level', () => {
  const html = '<h2>Part 1</h2><p>Text</p><h4>Deep</h4><p>More</p>';
  assert.deepEqual(findRefusedHeadings(html), ['h4']);
});

test('h1, h5 and h6 are refused too, deduplicated and sorted', () => {
  const html = '<h6>a</h6><h1>Title</h1><h5>b</h5><h5>c</h5><h2>ok</h2>';
  assert.deepEqual(findRefusedHeadings(html), ['h1', 'h5', 'h6']);
});

test('detection is case-insensitive and needs a real tag boundary', () => {
  assert.deepEqual(findRefusedHeadings('<H4 id="a">x</H4>'), ['h4']);
  // "<h4" inside text or a longer tag name is not a heading.
  assert.deepEqual(findRefusedHeadings('<p>&lt;h4&gt; literally</p><h40>nope</h40>'), []);
  assert.deepEqual(findRefusedHeadings(''), []);
  assert.deepEqual(findRefusedHeadings(null), []);
});

test('the refusal reason names the article, language and heading levels', () => {
  const reason = headingRefusalReason(245, 'es', ['h4']);
  assert.match(reason, /Article 245 ES/);
  assert.match(reason, /h4/);
  assert.match(reason, /h1–h3 only/);
});
