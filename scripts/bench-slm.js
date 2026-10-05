'use strict';

// Benchmark the local prompt classifier against a labelled prompt set.
//
// Usage: node scripts/bench-slm.js [model] [endpoint]
//   defaults: gemma3:270m  http://127.0.0.1:11434
//
// Reports latency (cold = first call, warm = the rest) and, for three
// classifiers (heuristic only, SLM only, combined decide()), accuracy and the
// false-nudge rate (complex prompts that would have been blocked).

const { classifyHeuristic, classifySlm, decide } = require('../hook/route.js');

const SIMPLE = [
  'what is a closure?',
  'regex to match an email',
  'difference between let and const',
  'how do I reverse a string in python',
  'explain what a mutex is',
  'syntax for a switch statement in go',
  'convert 5 miles to km',
  'what does the git rebase command do',
  'how to create a list comprehension',
  'translate "hello" to french',
  'what is the http status code for not found',
  'rename variable foo to bar in this line: let foo = 1',
  'what is big O notation',
  'how do I read a file in node',
  'meaning of the final keyword in java',
  'what is a pure function',
  'css to center a div',
  'sql syntax for left join',
  'what is the difference between tcp and udp',
  'bash command to list files by size',
];

const COMPLEX = [
  'add pagination to the users endpoint and update the tests',
  'why is my build failing after the upgrade?',
  'refactor the auth module to use JWT',
  'implement a retry mechanism in the payment client and cover it with tests',
  'the login page throws a null error after the redirect, find the cause in the codebase',
  'migrate the database layer from callbacks to async/await',
  'please look at the settings screen and make the toggles persist between sessions',
  'write unit tests for the order service including the failure paths',
  'update the CI workflow so it caches node_modules and runs lint before tests',
  'extend the hook installer so it also supports a second config file',
  'our dashboard is slow when there are many rows, profile it and speed it up',
  'create a new endpoint that exports reports as CSV and wire it into the UI',
  'the websocket reconnect logic drops messages, fix it',
  'design the data model for a multi-tenant notification system',
  'rewrite the parser so it handles nested quotes and add regression tests for it',
  'add dark mode support to all components and make the theme configurable',
  'investigate why the memory usage grows after every request in the worker',
  'split this large class into smaller modules without changing behaviour',
  'set up end-to-end tests for the checkout flow using the existing fixtures',
  'make the extension show a warning when the hook is not installed, and add a command to repair it',
];

const SET = [
  ...SIMPLE.map(p => ({ p, label: 'simple' })),
  ...COMPLEX.map(p => ({ p, label: 'complex' })),
];

const model    = process.argv[2] || 'gemma3:270m';
const endpoint = process.argv[3] || 'http://127.0.0.1:11434';
const cfg = { classifier: 'slm', endpoint, model, timeoutMs: 30000, keepAlive: -1 };

const pct = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

function report(name, rows) {
  const ok = rows.filter(r => r.pred === r.label).length;
  const complexRows = rows.filter(r => r.label === 'complex');
  const falseNudges = complexRows.filter(r => r.pred === 'simple').length;
  const simpleRows = rows.filter(r => r.label === 'simple');
  const missed = simpleRows.filter(r => r.pred === 'complex').length;
  console.log(
    `${name.padEnd(12)} accuracy ${ok}/${rows.length} (${Math.round(100 * ok / rows.length)}%)  ` +
    `false-nudge ${falseNudges}/${complexRows.length}  missed-nudge ${missed}/${simpleRows.length}`,
  );
}

(async () => {
  console.log(`Model: ${model}  Endpoint: ${endpoint}  Prompts: ${SET.length}\n`);

  const heur = SET.map(({ p, label }) => ({
    p, label, pred: classifyHeuristic(p, []).nudge ? 'simple' : 'complex',
  }));

  const slm = [];
  const latencies = [];
  let coldMs = null;
  for (const { p, label } of SET) {
    const t = Date.now();
    let pred;
    try { pred = await classifySlm(p, [], cfg); } catch (e) { pred = 'error'; }
    const ms = Date.now() - t;
    if (coldMs === null) coldMs = ms; else latencies.push(ms);
    slm.push({ p, label, pred });
  }

  const combined = [];
  for (const { p, label } of SET) {
    const r = await decide(p, [], 'claude-opus-5', cfg);
    combined.push({ p, label, pred: r.nudge ? 'simple' : 'complex' });
  }

  console.log(`Latency: cold ${coldMs} ms, warm p50 ${pct(latencies, 0.5)} ms, p95 ${pct(latencies, 0.95)} ms\n`);
  report('heuristic', heur);
  report('slm only', slm);
  report('combined', combined);

  console.log('\nSLM disagreements:');
  for (const r of slm.filter(r => r.pred !== r.label)) console.log(`  [${r.label} -> ${r.pred}] ${r.p}`);
})();
