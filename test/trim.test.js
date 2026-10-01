'use strict';

// Tests for src/trim.ts (compiled to out/trim.js — run `npm run compile` first).

const { test } = require('node:test');
const assert   = require('node:assert/strict');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { trimFile, appendAndTrim, MAX_ENTRIES } = require('../out/trim.js');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecologits-trim-'));
  return path.join(dir, 'data.jsonl');
}

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
}

test('MAX_ENTRIES is 100', () => {
  assert.equal(MAX_ENTRIES, 100);
});

test('appendAndTrim creates the file and writes the line', () => {
  const f = tmpFile();
  appendAndTrim(f, 'one\n');
  assert.equal(fs.readFileSync(f, 'utf8'), 'one\n');
});

test('appendAndTrim keeps all entries when under the limit', () => {
  const f = tmpFile();
  for (let i = 0; i < 50; i++) appendAndTrim(f, `line ${i}\n`);
  const lines = readLines(f);
  assert.equal(lines.length, 50);
  assert.equal(lines[0], 'line 0');
});

test('appendAndTrim keeps exactly 100 entries at the limit', () => {
  const f = tmpFile();
  for (let i = 0; i < 100; i++) appendAndTrim(f, `line ${i}\n`);
  const lines = readLines(f);
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'line 0');
  assert.equal(lines[99], 'line 99');
});

test('appendAndTrim drops the oldest entry beyond 100', () => {
  const f = tmpFile();
  for (let i = 0; i < 101; i++) appendAndTrim(f, `line ${i}\n`);
  const lines = readLines(f);
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'line 1');
  assert.equal(lines[99], 'line 100');
});

test('appendAndTrim keeps only the last 100 after many writes', () => {
  const f = tmpFile();
  for (let i = 0; i < 350; i++) appendAndTrim(f, JSON.stringify({ i }) + '\n');
  const lines = readLines(f);
  assert.equal(lines.length, 100);
  assert.equal(JSON.parse(lines[0]).i, 250);
  assert.equal(JSON.parse(lines[99]).i, 349);
  assert.ok(fs.readFileSync(f, 'utf8').endsWith('\n'));
});

test('appendAndTrim respects a custom max', () => {
  const f = tmpFile();
  for (let i = 0; i < 10; i++) appendAndTrim(f, `l${i}\n`, 3);
  assert.deepEqual(readLines(f), ['l7', 'l8', 'l9']);
});

test('trimFile trims a pre-existing oversized file and ignores blank lines', () => {
  const f = tmpFile();
  const content = Array.from({ length: 250 }, (_, i) => `row ${i}`).join('\n\n') + '\n';
  fs.writeFileSync(f, content, 'utf8');
  trimFile(f);
  const lines = readLines(f);
  assert.equal(lines.length, 100);
  assert.equal(lines[0], 'row 150');
  assert.equal(lines[99], 'row 249');
});

test('trimFile leaves a small file untouched', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'a\nb\n', 'utf8');
  trimFile(f);
  assert.equal(fs.readFileSync(f, 'utf8'), 'a\nb\n');
});

test('trimFile does not throw for a missing file', () => {
  assert.doesNotThrow(() => trimFile(path.join(os.tmpdir(), 'ecologits-does-not-exist.jsonl')));
});
