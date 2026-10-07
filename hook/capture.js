'use strict';

// capture.js — afterAgentResponse hook for Cursor.
// Reads the hook JSON payload from stdin, extracts the token/model data,
// and appends one line to ~/.cursor/ecologits/responses.jsonl.
// Always exits 0 (non-blocking). Never makes network calls.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { localTimestamp } = require('./localTimestamp');

const DATA_DIR   = path.join(os.homedir(), '.cursor', 'ecologits');
const EVENTS_FILE = path.join(DATA_DIR, 'responses.jsonl');
const LOG_FILE    = path.join(DATA_DIR, 'ecologits.log');
const SUMMARY_MAX = 100;

const MAX_ENTRIES = 100;

function appendAndTrim(file, line) {
  fs.appendFileSync(file, line, 'utf8');

  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '');
    
    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(file, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch (_) { /* ignore */ }
}

function writeLog(level, msg) {
  try {
    const ts = localTimestamp();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    appendAndTrim(LOG_FILE, `${ts} [${level}] ${msg}\n`);
  } catch (_) { /* nowhere to report */ }
}

const logError = msg => writeLog('ERROR', msg);
const logInfo  = msg => writeLog('INFO', msg);

function getSummary(text) {
  if (!text || typeof text !== 'string') return '';
  const lines = text.split('\n');
  const first = lines.find(l => l.trim() !== '') || '';
  // Strip common markdown markers
  const clean = first
    .replace(/^[\s#*>`~\-=]+/, '')
    .replace(/`+/g, '')
    .replace(/\*+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > SUMMARY_MAX ? clean.slice(0, SUMMARY_MAX) + '...' : clean;
}

function generateId() {
  // Combine timestamp with random hex to avoid collisions from parallel agents
  const rnd = Math.random().toString(16).slice(2, 8);
  return `${Date.now()}-${rnd}`;
}

let raw = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    let payload;
    try {
      payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (e) {
      logError(`capture.js: failed to parse payload: ${e.message}`);
      process.stdout.write('{}\n');
      process.exit(0);
    }

    // Extract fields from payload
    const conversationId  = payload.conversation_id  || '';
    const generationId    = payload.generation_id    || '';
    const modelId         = payload.model_id         || payload.model || '';
    const modelParams     = Array.isArray(payload.model_params) ? payload.model_params : [];
    const outputTokens    = typeof payload.output_tokens === 'number' ? payload.output_tokens : 0;
    const workspaceRoots  = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const summary         = getSummary(payload.text);

    if (!modelId || outputTokens === 0) {
      // Nothing useful to record (e.g. a thought block with no tokens)
      logInfo('capture.js: skipped event (no model or output tokens)');
      process.stdout.write('{}\n');
      process.exit(0);
    }

    const event = {
      id:              generateId(),
      ts:              new Date().toISOString(),
      conversationId,
      generationId,
      model:           modelId,
      modelParams,
      outputTokens,
      workspaceRoots,
      summary,
    };

    const line = JSON.stringify(event) + '\n';

    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      appendAndTrim(EVENTS_FILE, line);
      logInfo(`capture.js: recorded ${modelId}, ${outputTokens} output tokens`);
    } catch (e) {
      logError(`capture.js: failed to write event: ${e.message}`);
    }
  } catch (e) {
    logError(`capture.js: unhandled error: ${e.message}`);
  }

  process.stdout.write('{}\n');
  process.exit(0);
});
