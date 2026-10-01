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
// Always exits 0. Errors go to ~/.cursor/ecologits/error.log. Never makes
// network calls.

const fs   = require('fs');
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
function classify(prompt, attachments, model) {
  if (typeof prompt !== 'string') {
    return { nudge: false, reason: 'non-string-prompt' };
  }

  const trimmed = prompt.trim();

  // Rule 1: explicit user override
  if (trimmed.startsWith('!big')) {
    return { nudge: false, reason: 'override' };
  }

  // Rule 2: already on a small model
  if (typeof model === 'string' && SMALL_MODEL_RE.test(model)) {
    return { nudge: false, reason: 'small-model' };
  }

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
// Main — stdin handling (only runs when called as a script)
// ---------------------------------------------------------------------------

if (require.main === module) {
  // Watchdog: fail-open after 1500 ms so we never block the user.
  const watchdog = setTimeout(() => {
    logError('route.js: watchdog timeout — allowing prompt');
    allow();
  }, 1500);
  // Don't let the timer prevent the process from exiting if we finish first.
  watchdog.unref();

  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { raw += chunk; });
  process.stdin.on('end', () => {
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

      const result = classify(prompt, attachments, model);

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
module.exports = { classify };
