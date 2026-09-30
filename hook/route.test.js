'use strict';

// route.test.js — unit tests for classify() in route.js.
// Run with: node --test hook/
// No extra dependencies required (uses built-in node:test and node:assert).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { classify } = require('./route.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shorthand: call classify with no attachments and no model. */
function c(prompt, { attachments = [], model = 'claude-opus-5' } = {}) {
  return classify(prompt, attachments, model);
}

// ---------------------------------------------------------------------------
// Simple prompts — should be nudged
// ---------------------------------------------------------------------------

test('question-word prefix: "what is" → nudge', () => {
  const r = c('what is a closure?');
  assert.equal(r.nudge, true);
  assert.equal(r.reason, 'question-word');
});

test('question-word prefix: "how do i" → nudge', () => {
  const r = c('how do i center a div in CSS?');
  assert.equal(r.nudge, true);
});

test('question-word prefix: "how to" → nudge', () => {
  const r = c('how to reverse a string in python');
  assert.equal(r.nudge, true);
});

test('question-word prefix: "explain" → nudge', () => {
  const r = c('explain promises in JavaScript');
  assert.equal(r.nudge, true);
});

test('question-word prefix: "why" → nudge', () => {
  const r = c("why doesn't this regex match?");
  assert.equal(r.nudge, true);
});

test('question-word prefix: "difference between" → nudge', () => {
  const r = c('difference between null and undefined');
  assert.equal(r.nudge, true);
});

test('short prompt (no question word) → nudge (short-prompt)', () => {
  const r = c('list HTTP status codes');
  assert.equal(r.nudge, true);
  assert.equal(r.reason, 'short-prompt');
});

test('very short single-word prompt → nudge', () => {
  const r = c('hello');
  assert.equal(r.nudge, true);
});

// ---------------------------------------------------------------------------
// Complex prompts — should NOT be nudged
// ---------------------------------------------------------------------------

test('long prompt (>500 chars) → allow', () => {
  const r = c('a'.repeat(501));
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'long-prompt');
});

test('complex keyword "refactor" → allow', () => {
  const r = c('refactor the auth module to use JWT');
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'complex-keyword');
});

test('complex keyword "implement" → allow', () => {
  const r = c('implement a binary search tree in TypeScript');
  assert.equal(r.nudge, false);
});

test('complex keyword "debug" → allow', () => {
  const r = c('debug why my tests are failing');
  assert.equal(r.nudge, false);
});

test('complex keyword "write tests" → allow', () => {
  const r = c('write tests for the payment service');
  assert.equal(r.nudge, false);
});

test('complex keyword "across" → allow', () => {
  const r = c('rename this function across the codebase');
  assert.equal(r.nudge, false);
});

test('multiple attachments → allow', () => {
  const r = c('review these files', {
    attachments: [{ type: 'file', file_path: 'a.ts' }, { type: 'file', file_path: 'b.ts' }],
  });
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'multiple-attachments');
});

test('large code fence (>=15 lines) → allow', () => {
  const lines = Array.from({ length: 16 }, (_, i) => `line ${i}`).join('\n');
  const r = c(`what does this do?\n\`\`\`\n${lines}\n\`\`\``);
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'large-code-fence');
});

test('many sentences (>4) → allow', () => {
  // 6 sentences so that, after prompt.trim(), there are still 5 ". " pairs
  // (the regex requires a whitespace after the punctuation mark).
  // Avoid any complex keywords — the sentence-count rule must be reached first.
  const prompt = 'Update A. Update B. Update C. Update D. Update E. Update F.';
  const r = c(prompt);
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'many-sentences');
});

// ---------------------------------------------------------------------------
// !big override
// ---------------------------------------------------------------------------

test('"!big" prefix → allow regardless of simplicity', () => {
  const r = c('!big what is a closure?');
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'override');
});

// ---------------------------------------------------------------------------
// Small model — should never be nudged
// ---------------------------------------------------------------------------

test('model contains "mini" → allow', () => {
  const r = c('what is async/await?', { model: 'gpt-5.5-mini' });
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'small-model');
});

test('model contains "haiku" → allow', () => {
  const r = c('explain closures', { model: 'claude-haiku-3' });
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'small-model');
});

test('model contains "flash" → allow', () => {
  const r = c('how to sort a list?', { model: 'gemini-flash-2' });
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'small-model');
});

test('model contains "composer" → allow', () => {
  const r = c('what is a closure?', { model: 'composer-2.5-fast' });
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'small-model');
});

// ---------------------------------------------------------------------------
// Edge cases — invalid input should always allow
// ---------------------------------------------------------------------------

test('empty prompt → nudge (short-prompt)', () => {
  // Empty string is ≤120 chars and has no complex signals; it counts as short.
  const r = c('');
  assert.equal(r.nudge, true);
});

test('non-string prompt → allow', () => {
  const r = classify(null, [], 'claude-opus-5');
  assert.equal(r.nudge, false);
  assert.equal(r.reason, 'non-string-prompt');
});

test('undefined attachments treated as empty array → no crash', () => {
  const r = classify('what is X?', undefined, 'claude-opus-5');
  assert.equal(r.nudge, true);
});

test('single attachment → not blocked by attachment count', () => {
  const r = c('what does this file do?', {
    attachments: [{ type: 'file', file_path: 'a.ts' }],
  });
  // One attachment is fine; the prompt is short so it gets nudged.
  assert.equal(r.nudge, true);
});
