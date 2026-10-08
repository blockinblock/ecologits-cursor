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

// ---------------------------------------------------------------------------
// decide() — SLM classification with heuristic fallback
// ---------------------------------------------------------------------------

const http = require('node:http');
const { decide } = require('./route.js');

/** Start a fake Ollama server; handler(req,res) controls the response. */
function fakeOllama(handler) {
  return new Promise(resolve => {
    const state = { hits: 0 };
    const server = http.createServer((req, res) => { state.hits++; handler(req, res); });
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.endpoint = `http://127.0.0.1:${server.address().port}`;
      resolve(state);
    });
  });
}

const labelReply = label => (req, res) => {
  req.resume();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ message: { content: JSON.stringify({ label }) } }));
};

const cfgFor = (endpoint, extra = {}) => ({
  classifier: 'slm', endpoint, model: 'gemma3:270m', timeoutMs: 300, ...extra,
});

// A prompt the heuristic would nudge, one it flags as clearly complex, and
// an ambiguous one (no heuristic signal either way → default-allow).
const SIMPLE_P = 'what is a closure?';
const COMPLEX_P = 'refactor the auth module';
const AMBIGUOUS_P =
  'Could you tell me a little about how the weather works in the mountains during the long winter season in northern Europe, as a friendly overview';

test('decide: SLM "simple" → nudge even if heuristic would allow', async () => {
  const s = await fakeOllama(labelReply('simple'));
  try {
    const r = await decide(AMBIGUOUS_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    assert.deepEqual(r, { nudge: true, reason: 'slm-simple' });
    assert.equal(s.hits, 1);
  } finally { s.server.close(); }
});

test('decide: clearly complex prompt skips the SLM and is never nudged', async () => {
  const s = await fakeOllama(labelReply('simple'));
  try {
    const r = await decide(COMPLEX_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    assert.deepEqual(r, { nudge: false, reason: 'heuristic-complex:complex-keyword' });
    assert.equal(s.hits, 0);
  } finally { s.server.close(); }
});

test('decide: long prompt and multiple attachments skip the SLM', async () => {
  const s = await fakeOllama(labelReply('simple'));
  try {
    const a = await decide('what is a closure? ' + 'x'.repeat(600), [], 'claude-opus-5', cfgFor(s.endpoint));
    const b = await decide(SIMPLE_P, [{}, {}], 'claude-opus-5', cfgFor(s.endpoint));
    assert.equal(a.reason, 'heuristic-complex:long-prompt');
    assert.equal(b.reason, 'heuristic-complex:multiple-attachments');
    assert.equal(s.hits, 0);
  } finally { s.server.close(); }
});

test('decide: SLM "complex" → allow even if heuristic would nudge', async () => {
  const s = await fakeOllama(labelReply('complex'));
  try {
    const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    assert.deepEqual(r, { nudge: false, reason: 'slm-complex' });
  } finally { s.server.close(); }
});

test('decide: slow SLM → heuristic fallback', async () => {
  const s = await fakeOllama((req, res) => { req.resume(); setTimeout(() => res.end('{}'), 1000); });
  try {
    const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor(s.endpoint, { timeoutMs: 100 }));
    assert.equal(r.nudge, true);
    assert.equal(r.reason, 'fallback:question-word');
  } finally { s.server.closeAllConnections?.(); s.server.close(); }
});

test('decide: HTTP 500 → heuristic fallback', async () => {
  const s = await fakeOllama((req, res) => { req.resume(); res.statusCode = 500; res.end('boom'); });
  try {
    const r = await decide(AMBIGUOUS_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    assert.equal(r.nudge, false);
    assert.equal(r.reason, 'fallback:default-allow');
  } finally { s.server.close(); }
});

test('decide: malformed JSON → heuristic fallback', async () => {
  const s = await fakeOllama((req, res) => { req.resume(); res.end('not json'); });
  try {
    const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    assert.match(r.reason, /^fallback:/);
  } finally { s.server.close(); }
});

test('decide: connection refused → heuristic fallback', async () => {
  const s = await fakeOllama(labelReply('simple'));
  const endpoint = s.endpoint;
  await new Promise(r => s.server.close(r));
  const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor(endpoint));
  assert.equal(r.reason, 'fallback:question-word');
});

test('decide: non-loopback endpoint is rejected without a request', async () => {
  const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor('http://example.com:11434'));
  assert.equal(r.reason, 'fallback:question-word');
});

test('decide: !big and small-model prompts never reach the SLM', async () => {
  const s = await fakeOllama(labelReply('simple'));
  try {
    const a = await decide('!big ' + SIMPLE_P, [], 'claude-opus-5', cfgFor(s.endpoint));
    const b = await decide(SIMPLE_P, [], 'gpt-5.5-mini', cfgFor(s.endpoint));
    assert.equal(a.reason, 'override');
    assert.equal(b.reason, 'small-model');
    assert.equal(s.hits, 0);
  } finally { s.server.close(); }
});

test('decide: classifier "heuristic" skips the SLM', async () => {
  const s = await fakeOllama(labelReply('complex'));
  try {
    const r = await decide(SIMPLE_P, [], 'claude-opus-5', cfgFor(s.endpoint, { classifier: 'heuristic' }));
    assert.equal(r.reason, 'question-word');
    assert.equal(s.hits, 0);
  } finally { s.server.close(); }
});
