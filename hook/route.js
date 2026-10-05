'use strict';

// route.js — beforeSubmitPrompt hook for Cursor.
// Reads the hook JSON payload from stdin, classifies the prompt using simple
// heuristics, and either allows the prompt ({"continue":true}) or nudges the
// user to switch to a smaller model ({"continue":false,"user_message":"..."}).
//
// Rules:
//   1. If the prompt starts with "!big"  → allow (user override).
//   2. If the model looks small already  → allow (no point nudging).
//   3. If any COMPLEX signal matches     → allow (don't interrupt real work).
//   4. If any SIMPLE signal matches      → nudge.
//   5. Otherwise                         → allow.
//
// The simple/complex judgement (rules 3-5) is made by a local Ollama model
// (Gemma 3 270M) when reachable; the heuristics are the fallback when it is
// not. Clearly complex prompts (rule 3) skip the model entirely, and only a
// "simple" verdict from the model nudges.
// Config is read from ~/.cursor/ecologits/route-config.json.
//
// Always exits 0. Errors go to ~/.cursor/ecologits/error.log. The only network
// call is to the loopback Ollama endpoint.

const fs   = require('fs');
const http = require('http');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// Constants (all tuneable here at the top)
// ---------------------------------------------------------------------------

/** Maximum prompt length before treating the prompt as complex. */
const MAX_CHARS = 500;

/** Maximum prompt length below which a prompt may still be considered simple. */
const SHORT_CHARS = 120;

/** Maximum number of sentences / list items before treating as complex. */
const MAX_SENTENCE_COUNT = 4;

/** Minimum lines in a fenced code block to count as complex. */
const CODE_FENCE_LINES = 15;

/** Model name patterns that indicate the user already selected a small model. */
const SMALL_MODEL_RE = /(mini|nano|flash|haiku|lite|small|composer)/i;

/** Keywords that indicate a complex, agentic prompt. */
const COMPLEX_KEYWORDS_RE =
  /\b(refactor|implement|architect|migrate|debug|fix\s|across|codebase|all\s+files|write\s+tests|optimi[sz]e|design)\b/i;

/** Question-word or topic prefixes that strongly suggest a simple question. */
const SIMPLE_PREFIX_RE =
  /^(what|how\s+do\s+i|how\s+to|explain|why|what's|what\s+is|syntax|rename|translate|convert|regex|difference\s+between)\b/i;

const NUDGE_MESSAGE =
  'This looks like a simple question. A smaller model can answer it ' +
  'with a much lower environmental footprint. Switch the model and resend, ' +
  'or start your prompt with "!big" to keep the current model.';

const DATA_DIR   = path.join(os.homedir(), '.cursor', 'ecologits');
const ERROR_FILE = path.join(DATA_DIR, 'error.log');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_ENTRIES = 100;

function logError(msg) {
  try {
    const ts = new Date().toISOString();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(ERROR_FILE, `${ts}  ${msg}\n`, 'utf8');
    const lines = fs.readFileSync(ERROR_FILE, 'utf8').split('\n').filter(l => l.trim() !== '');

    if (lines.length > MAX_ENTRIES) {
      fs.writeFileSync(ERROR_FILE, lines.slice(-MAX_ENTRIES).join('\n') + '\n', 'utf8');
    }
  } catch (_) { /* nowhere to report */ }
}

function allow() {
  process.stdout.write('{"continue":true}\n');
  process.exit(0);
}

function nudge() {
  process.stdout.write(
    JSON.stringify({ continue: false, user_message: NUDGE_MESSAGE }) + '\n',
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Pure classification function (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Classify a prompt as simple (should be nudged) or not.
 *
 * @param {string} prompt       - The prompt text.
 * @param {Array}  attachments  - Array of attachment objects from the payload.
 * @param {string} model        - The model id / name string.
 * @returns {{ nudge: boolean, reason: string }}
 */
function checkPreRules(prompt, model) {
  if (typeof prompt !== 'string') {
    return { nudge: false, reason: 'non-string-prompt' };
  }

  // Rule 1: explicit user override
  if (prompt.trim().startsWith('!big')) {
    return { nudge: false, reason: 'override' };
  }

  // Rule 2: already on a small model
  if (typeof model === 'string' && SMALL_MODEL_RE.test(model)) {
    return { nudge: false, reason: 'small-model' };
  }

  return null;
}

function classify(prompt, attachments, model) {
  return checkPreRules(prompt, model) || classifyHeuristic(prompt, attachments);
}

function classifyHeuristic(prompt, attachments) {
  const trimmed = prompt.trim();

  // Rule 3: complex signals
  if (trimmed.length > MAX_CHARS) {
    return { nudge: false, reason: 'long-prompt' };
  }

  if (Array.isArray(attachments) && attachments.length > 1) {
    return { nudge: false, reason: 'multiple-attachments' };
  }

  // Large code fence: count lines between ``` markers
  const fenceMatches = trimmed.match(/```[\s\S]*?```/g) || [];
  for (const block of fenceMatches) {
    if (block.split('\n').length >= CODE_FENCE_LINES) {
      return { nudge: false, reason: 'large-code-fence' };
    }
  }

  if (COMPLEX_KEYWORDS_RE.test(trimmed)) {
    return { nudge: false, reason: 'complex-keyword' };
  }

  // Count sentences and list items as a rough structure signal
  const sentenceCount =
    (trimmed.match(/[.!?]+\s/g) || []).length +
    (trimmed.match(/^[-*]\s/gm) || []).length;
  if (sentenceCount > MAX_SENTENCE_COUNT) {
    return { nudge: false, reason: 'many-sentences' };
  }

  // Rule 4: simple signals
  if (SIMPLE_PREFIX_RE.test(trimmed)) {
    return { nudge: true, reason: 'question-word' };
  }

  if (trimmed.length <= SHORT_CHARS) {
    return { nudge: true, reason: 'short-prompt' };
  }

  // Rule 5: default — allow
  return { nudge: false, reason: 'default-allow' };
}

// ---------------------------------------------------------------------------
// SLM classification (local Ollama)
// ---------------------------------------------------------------------------

const CONFIG_FILE = path.join(DATA_DIR, 'route-config.json');

const DEFAULT_CONFIG = {
  classifier: 'slm',
  endpoint:   'http://127.0.0.1:11434',
  model:      'gemma3:270m',
  timeoutMs:  1000,
  keepAlive:  -1,
};

/** Extra time after the SLM timeout before the watchdog gives up (ms). */
const WATCHDOG_MARGIN_MS = 1000;

const MAX_PROMPT_CHARS = 1000;

/** Small-model request limits: keep the KV cache and output tiny for speed. */
const NUM_CTX     = 2048;
const NUM_PREDICT = 12;

// A 270M model labels nearly everything "simple" with a plain instruction
// (benchmarked: 19/20 complex prompts misclassified). A rule centred on
// "needs the user's own project" plus balanced few-shot chat turns fixes that.
const SYSTEM_PROMPT =
  'Decide if a request needs work on the user\'s own project. Answer "complex" if the ' +
  'request mentions the user\'s code, app, files, a bug, a build, tests, a feature or a ' +
  'change. Answer "simple" only if it is a general knowledge or syntax question that ' +
  'needs no project. Reply only with JSON {"label":"simple"} or {"label":"complex"}.';

const FEW_SHOT = [
  ['what is a promise in javascript?',                         'simple'],
  ['add caching to the products endpoint and update the tests', 'complex'],
  ['regex to match a phone number',                            'simple'],
  ['fix the bug in my login page',                             'complex'],
  ['difference between a list and a tuple',                    'simple'],
  ['refactor the billing module to use async/await',           'complex'],
  ['how do I sort a dict by value in python',                  'simple'],
  ['write tests for the invoice service',                      'complex'],
  ['syntax for a for loop in rust',                            'simple'],
  ['make the profile page save its values',                    'complex'],
  ['explain what an API is',                                   'simple'],
  ['why does my deploy keep failing?',                         'complex'],
].flatMap(([q, label]) => [
  { role: 'user', content: q },
  { role: 'assistant', content: JSON.stringify({ label }) },
]);

/** Heuristic reasons that mean "clearly complex": the SLM is not consulted. */
const COMPLEX_REASONS = new Set([
  'long-prompt', 'multiple-attachments', 'large-code-fence', 'complex-keyword', 'many-sentences',
]);

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, ''));
    if (parsed && typeof parsed === 'object') return { ...DEFAULT_CONFIG, ...parsed };
  } catch (_) { /* missing or malformed — use defaults */ }
  return { ...DEFAULT_CONFIG };
}

function isLoopbackHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

/**
 * Ask the local Ollama model to label the prompt.
 * Resolves to 'simple' | 'complex'; rejects on any failure.
 */
function classifySlm(prompt, attachments, cfg) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(cfg.endpoint);
    } catch (_) {
      return reject(new Error(`invalid endpoint: ${cfg.endpoint}`));
    }
    if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) {
      return reject(new Error(`non-loopback endpoint rejected: ${url.hostname}`));
    }

    const body = JSON.stringify({
      model: cfg.model,
      stream: false,
      think: false, // thinking models would burn num_predict on reasoning and return no content
      keep_alive: cfg.keepAlive,
      format: {
        type: 'object',
        properties: { label: { type: 'string', enum: ['simple', 'complex'] } },
        required: ['label'],
      },
      options: { temperature: 0, num_predict: NUM_PREDICT, num_ctx: NUM_CTX },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...FEW_SHOT,
        { role: 'user', content: prompt.trim().slice(0, MAX_PROMPT_CHARS) },
      ],
    });

    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };

    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || 80,
      path: '/api/chat',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return done(reject, new Error(`HTTP ${res.statusCode}`));
        try {
          const content = JSON.parse(data).message.content;
          const label = JSON.parse(content).label;
          if (label === 'simple' || label === 'complex') return done(resolve, label);
          done(reject, new Error(`unexpected label: ${label}`));
        } catch (e) {
          done(reject, new Error(`bad response: ${e.message}`));
        }
      });
      res.on('error', e => done(reject, e));
    });

    const timer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`timeout after ${cfg.timeoutMs} ms`));
    }, cfg.timeoutMs);

    req.on('error', e => done(reject, e));
    req.end(body);
  });
}

/**
 * Full decision: pre-rules, then SLM, falling back to the heuristic when the
 * SLM is unreachable or misbehaves.
 */
async function decide(prompt, attachments, model, cfg) {
  const pre = checkPreRules(prompt, model);
  if (pre) return pre;

  if (!cfg || cfg.classifier !== 'slm') {
    return classifyHeuristic(prompt, attachments);
  }

  // Pre-filter: clearly complex prompts are allowed without a model call. A
  // small model is least reliable there, and a false nudge blocks real work.
  const heur = classifyHeuristic(prompt, attachments);
  if (!heur.nudge && COMPLEX_REASONS.has(heur.reason)) {
    return { nudge: false, reason: `heuristic-complex:${heur.reason}` };
  }

  // Only a "simple" verdict nudges, and only when no complex signal fired.
  try {
    const label = await classifySlm(prompt, attachments, cfg);
    return label === 'simple'
      ? { nudge: true,  reason: 'slm-simple' }
      : { nudge: false, reason: 'slm-complex' };
  } catch (e) {
    logError(`route.js: SLM unavailable, using heuristic: ${e.message}`);
    return { nudge: heur.nudge, reason: `fallback:${heur.reason}` };
  }
}

// ---------------------------------------------------------------------------
// Main — stdin handling (only runs when called as a script)
// ---------------------------------------------------------------------------

if (require.main === module) {
  const cfg = loadConfig();

  // Heuristic verdict, computed as soon as the payload is parsed, so the
  // watchdog can still nudge instead of blindly allowing when the SLM stalls.
  let fallback = null;

  // Watchdog: must fire after the SLM timeout but before Cursor's hook timeout
  // (5 s in hooks.json). Fails open unless the heuristic already says "nudge".
  const watchdog = setTimeout(() => {
    logError('route.js: watchdog timeout — using heuristic verdict');
    if (fallback && fallback.nudge) nudge();
    else allow();
  }, (Number(cfg.timeoutMs) || 0) + WATCHDOG_MARGIN_MS);
  // Don't let the timer prevent the process from exiting if we finish first.
  watchdog.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', async () => {
    try {
      let payload;
      try {
        payload = JSON.parse(raw.replace(/^\uFEFF/, ''));
      } catch (e) {
        logError(`route.js: failed to parse payload: ${e.message}`);
        return allow();
      }

      const prompt      = payload.prompt      || '';
      const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
      const model       = payload.model_id    || payload.model || '';

      fallback = checkPreRules(prompt, model) || classifyHeuristic(prompt, attachments);
      const result = await decide(prompt, attachments, model, cfg);

      if (result.nudge) {
        nudge();
      } else {
        allow();
      }
    } catch (e) {
      logError(`route.js: unhandled error: ${e.message}`);
      allow();
    }
  });
}

// Export for tests
module.exports = { classify, classifyHeuristic, checkPreRules, classifySlm, decide };
