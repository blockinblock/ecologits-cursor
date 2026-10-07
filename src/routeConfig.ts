import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as cp from 'child_process';
import { DATA_DIR } from './store';

const CONFIG_FILE = path.join(DATA_DIR, 'route-config.json');

export interface RouteConfig {
  classifier: 'slm' | 'heuristic';
  endpoint: string;
  model: string;
  timeoutMs: number;
  keepAlive: number | string;
}

export function readRouteConfig(): RouteConfig {
  const c = vscode.workspace.getConfiguration('ecologitsCursor');
  return {
    classifier: c.get<'slm' | 'heuristic'>('nudge.classifier', 'slm'),
    endpoint:   c.get<string>('nudge.slm.endpoint', 'http://127.0.0.1:11434'),
    model:      c.get<string>('nudge.slm.model', 'gemma3:270m'),
    timeoutMs:  c.get<number>('nudge.slm.timeoutMs', 1000),
    keepAlive:  c.get<number | string>('nudge.slm.keepAlive', -1),
  };
}

/** Write settings where route.js reads them on every run. */
export function writeRouteConfig(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(readRouteConfig(), null, 2) + '\n', 'utf8');
  } catch {
    /* non-fatal: hook falls back to defaults */
  }
}

interface HttpResult { status: number; body: string; }

function ollamaRequest(
  cfg: RouteConfig,
  method: 'GET' | 'POST',
  apiPath: string,
  payload: unknown,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;

    try {
      url = new URL(cfg.endpoint);
    } catch {
      return reject(new Error(`Invalid endpoint: ${cfg.endpoint}`));
    }

    const body = payload === undefined ? undefined : JSON.stringify(payload);
    const req = http.request({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || 80,
      path: apiPath,
      method,
      headers: body
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        : {},
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function isOllamaUp(cfg: RouteConfig): Promise<boolean> {
  try {
    return (await ollamaRequest(cfg, 'GET', '/api/version', undefined, 2000)).status === 200;
  } catch {
    return false;
  }
}

async function waitForOllama(cfg: RouteConfig, totalMs: number): Promise<boolean> {
  const deadline = Date.now() + totalMs;

  while (Date.now() < deadline) {
    if (await isOllamaUp(cfg)){
        return true;
    }

    await sleep(750);
  }
  return isOllamaUp(cfg);
}

function isLoopbackEndpoint(cfg: RouteConfig): boolean {
  try {
    const h = new URL(cfg.endpoint).hostname.replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false; 
  }
}

/** Candidate executables: PATH first, then the per-user Windows install location. */
function ollamaCandidates(): string[] {
  const list = ['ollama'];

  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  }

  return list;
}

/** Try each candidate; resolves true if a process was spawned, false if none could be. */
function spawnOllama(cfg: RouteConfig): Promise<boolean> {
  const env = { ...process.env, OLLAMA_KEEP_ALIVE: String(cfg.keepAlive) };
  const tryNext = (i: number): Promise<boolean> => {
    if (i >= ollamaCandidates().length) {
      return Promise.resolve(false);
    }
    
    return new Promise(resolve => {
      let settled = false;

      try {
        const child = cp.spawn(ollamaCandidates()[i], ['serve'], {
          detached: true, stdio: 'ignore', windowsHide: true, env,
        });
        child.once('error', () => {
           if (!settled) { 
            settled = true; resolve(tryNext(i + 1)); 
            } 
          });
        child.once('spawn', () => { 
          if (!settled) {
             settled = true; child.unref(); resolve(true);
          } 
        });
      } catch {
        if (!settled) {
          settled = true; resolve(tryNext(i + 1)); 
        }
      }
    });
  };
  return tryNext(0);
}

let notifiedMissing = false;

/** Make sure the local Ollama server is reachable, starting it if allowed. */
async function ensureOllamaRunning(cfg: RouteConfig): Promise<boolean> {
  if (await isOllamaUp(cfg)) {
      return true;
  }

  if (!isLoopbackEndpoint(cfg)){
    return false;
  }

  const autostartConfigExists = vscode.workspace.getConfiguration('ecologitsCursor').get<boolean>('nudge.slm.autoStart', true);
  if (!autostartConfigExists) {
    return false;
  }

  // The Ollama tray app may be starting at login; give it a moment first.
  if (await waitForOllama(cfg, 4000)) {
    return true;
  }

  if (!(await spawnOllama(cfg))) {
    if (!notifiedMissing) {
      notifiedMissing = true;
      void vscode.window.showWarningMessage(
        'EcoLogits: Ollama is not installed or not on PATH. Install it from https://ollama.com. ' +
        'Heuristic classification is used meanwhile.');
    }
    return false;
  }
  return waitForOllama(cfg, 30_000);
}

let warming: Promise<void> | undefined;

/** Fire-and-forget: ensure Ollama is running, then load the model so the first prompt is fast. */
export function warmUpModel(): void {
  if (warming){
    return;
  }

  const cfg = readRouteConfig();
  
  if (cfg.classifier !== 'slm') {
    return;
  }

  warming = (async () => {
    if (!(await ensureOllamaRunning(cfg))) {
      return;
    }

    await ollamaRequest(cfg, 'POST', '/api/generate',
      { model: cfg.model, keep_alive: cfg.keepAlive }, 120_000);
  })()
  .catch(() => { 
    /* best effort */
  })
  .finally(() => {
    warming = undefined;});
}

/** Verify Ollama, the model, and a test classification; report to the user. */
export async function checkClassifier(): Promise<void> {
  const cfg = readRouteConfig();
  const fail = (msg: string) => { void vscode.window.showWarningMessage(`EcoLogits: ${msg}`); };

  try {
    const v = await ollamaRequest(cfg, 'GET', '/api/version', undefined, 3000);
    if (v.status !== 200) return fail(`Ollama at ${cfg.endpoint} answered HTTP ${v.status}.`);
  } catch (e) {
    return fail(`Ollama is not reachable at ${cfg.endpoint} (${(e as Error).message}). ` +
      'Install it from https://ollama.com and make sure it is running. Heuristic classification is used meanwhile.');
  }

  try {
    const t = await ollamaRequest(cfg, 'GET', '/api/tags', undefined, 3000);
    const models: { name: string }[] = JSON.parse(t.body).models ?? [];
    const wanted = cfg.model.includes(':') ? cfg.model : `${cfg.model}:latest`;

    if (!models.some(m => m.name === wanted)) {
      return fail(`Model "${cfg.model}" is not installed. Run: ollama pull ${cfg.model}`);
    }
  } catch (e) {
    return fail(`Could not list Ollama models: ${(e as Error).message}`);
  }

  // Same request options as the hook. Run twice: the first call may include
  // model load time, the second one shows the warm latency the hook sees.
  const classify = () => ollamaRequest(cfg, 'POST', '/api/chat', {
    model: cfg.model,
    stream: false,
    think: false,
    keep_alive: cfg.keepAlive,
    format: {
      type: 'object',
      properties: { label: { type: 'string', enum: ['simple', 'complex'] } },
      required: ['label'],
    },
    options: { temperature: 0, num_predict: 12, num_ctx: 2048 },
    messages: [
      { role: 'system', content: 'Label a request to a coding assistant as simple or complex. Reply as JSON {"label":"simple"|"complex"}.' },
      { role: 'user', content: 'what is a closure?' },
    ],
  }, 60_000);

  try {
    const t0 = Date.now();
    const first = await classify();

    if (first.status !== 200) {
      return fail(`Test classification failed (HTTP ${first.status}).`);
    }

    const coldMs = Date.now() - t0;
    const t1 = Date.now();
    const second = await classify();
    
    if (second.status !== 200) {
      return fail(`Test classification failed (HTTP ${second.status}).`);
    }
    const warmMs = Date.now() - t1;

    if (warmMs > cfg.timeoutMs) {
      return fail(`Local classifier works (${cfg.model}) but warm latency ${warmMs} ms exceeds the ` +
        `${cfg.timeoutMs} ms hook budget; prompts will fall back to heuristics. Increase the timeout or use a smaller model.`);
    }

    void vscode.window.showInformationMessage(
      `EcoLogits: local classifier OK (${cfg.model}, first call ${coldMs} ms, warm ${warmMs} ms).`);
  } catch (e) {
    fail(`Test classification failed: ${(e as Error).message}`);
  }
}
