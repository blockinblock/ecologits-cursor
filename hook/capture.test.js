'use strict';

// capture.test.js — runs capture.js as a child process against a temporary
// home directory and checks the files it writes and the 100-entry cap.

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const CAPTURE = path.join(__dirname, 'capture.js');
const ROUTE   = path.join(__dirname, 'route.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ecologits-home-'));
}

function run(script, home, input) {
  return spawnSync(process.execPath, [script], {
    input,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

function dataFile(home, name) {
  return path.join(home, '.cursor', 'ecologits', name);
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

function payload(n) {
  return JSON.stringify({
    conversation_id: 'conv',
    generation_id:   `gen-${n}`,
    model_id:        'gpt-4o',
    output_tokens:   n + 1,
    workspace_roots: ['/ws'],
    text:            `response ${n}`,
  });
}

test('capture.js writes one valid JSON line to responses.jsonl', () => {
  const home = tmpHome();
  const r = run(CAPTURE, home, payload(0));
  assert.equal(r.status, 0);
  const lines = readLines(dataFile(home, 'responses.jsonl'));
  assert.equal(lines.length, 1);
  const ev = JSON.parse(lines[0]);
  assert.equal(ev.model, 'gpt-4o');
  assert.equal(ev.outputTokens, 1);
  assert.equal(ev.generationId, 'gen-0');
  assert.equal(ev.summary, 'response 0');
});

test('capture.js skips events without model or tokens', () => {
  const home = tmpHome();
  run(CAPTURE, home, JSON.stringify({ model_id: 'gpt-4o', output_tokens: 0 }));
  assert.equal(fs.existsSync(dataFile(home, 'responses.jsonl')), false);
});

test('capture.js keeps only the last 100 responses', () => {
  const home = tmpHome();
  for (let i = 0; i < 105; i++) run(CAPTURE, home, payload(i));
  const lines = readLines(dataFile(home, 'responses.jsonl'));
  assert.equal(lines.length, 100);
  assert.equal(JSON.parse(lines[0]).generationId, 'gen-5');
  assert.equal(JSON.parse(lines[99]).generationId, 'gen-104');
});

test('capture.js writes errors to ecologits.log and caps it at 100 entries', () => {
  const home = tmpHome();
  for (let i = 0; i < 103; i++) run(CAPTURE, home, `not json ${i}`);
  const file = dataFile(home, 'ecologits.log');
  assert.ok(fs.existsSync(file));
  const lines = readLines(file);
  assert.equal(lines.length, 100);
  assert.match(lines[0], /^\S+ \[ERROR\] capture\.js: failed to parse payload/);
});

test('capture.js logs an [INFO] line for a recorded event', () => {
  const home = tmpHome();
  run(CAPTURE, home, payload(0));
  const lines = readLines(dataFile(home, 'ecologits.log'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\S+ \[INFO\] capture\.js: recorded gpt-4o, 1 output tokens/);
});

test('route.js logs an [INFO] line with the verdict', () => {
  const home = tmpHome();
  const r = run(ROUTE, home, JSON.stringify({ prompt: '!big hello', model_id: 'gpt-4o' }));
  assert.equal(r.status, 0);
  const lines = readLines(dataFile(home, 'ecologits.log'));
  assert.match(lines[0], /^\S+ \[INFO\] route\.js: allow \(override\)/);
});

test('route.js caps ecologits.log at 100 entries', () => {
  const home = tmpHome();
  for (let i = 0; i < 102; i++) {
    const r = run(ROUTE, home, 'not json');
    assert.equal(r.status, 0);
  }
  const lines = readLines(dataFile(home, 'ecologits.log'));
  assert.equal(lines.length, 100);
});
