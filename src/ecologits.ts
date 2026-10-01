import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import type { ResponseEvent } from './store';
import { appendAndTrim } from './trim';

const DATA_DIR    = path.join(os.homedir(), '.cursor', 'ecologits');
const IMPACTS_FILE = path.join(DATA_DIR, 'impacts.jsonl');
const ERROR_FILE   = path.join(DATA_DIR, 'error.log');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImpactResult {
  id:     string;
  status: 'ok' | 'unsupported-model' | 'api-error' | 'no-data';
  gwp?:   number;
  wcf?:   number;
  energy?: number;
  adpe?:  number;
  pe?:    number;
}

interface ApiImpactValue {
  min: number;
  max: number;
}

interface ApiResponse {
  impacts?: {
    gwp?:    { value?: ApiImpactValue };
    wcf?:    { value?: ApiImpactValue };
    energy?: { value?: ApiImpactValue };
    adpe?:   { value?: ApiImpactValue };
    pe?:     { value?: ApiImpactValue };
  };
}

// ---------------------------------------------------------------------------
// Provider resolution — mirrors Resolve-Provider from ecologits-audit.ps1
// ---------------------------------------------------------------------------

export function resolveProvider(modelId: string): string | null {
  const m = modelId.toLowerCase();
  if (m.startsWith('claude-'))                                              return 'anthropic';
  if (/^(gpt-|o\d)/.test(m))                                               return 'openai';
  if (m.startsWith('gemini-') || m.startsWith('gemma-'))                   return 'google_genai';
  if (m.startsWith('mistral-') || m.startsWith('codestral-') ||
      m.startsWith('magistral-') || m.startsWith('devstral-'))             return 'mistralai';
  return null;
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------

function mid(range: ApiImpactValue): number {
  return (range.min + range.max) / 2;
}

function logError(msg: string): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    appendAndTrim(ERROR_FILE, `${new Date().toISOString()}  ${msg}\n`);
  } catch { /* nowhere to report */ }
}

function fetchImpacts(
  event:  ResponseEvent,
  zone:   string,
  apiUrl: string,
): Promise<ImpactResult> {
  const provider = resolveProvider(event.model);

  if (!provider) {
    return Promise.resolve({ id: event.id, status: 'unsupported-model' });
  }

  return new Promise(resolve => {
    const body = JSON.stringify({
      provider,
      model_name:           event.model,
      output_token_count:   event.outputTokens,
      electricity_mix_zone: zone,
    });

    let url: URL;
    try { url = new URL(apiUrl); } catch {
      resolve({ id: event.id, status: 'api-error' });
      return;
    }

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? '443' : '80'),
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const lib = url.protocol === 'https:' ? https : http;

    const req = lib.request(options, res => {
      let data = '';
      res.on('data', (chunk: string) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data) as ApiResponse;
          const i = json?.impacts;
          if (
            i?.gwp?.value && i?.wcf?.value && i?.energy?.value &&
            i?.adpe?.value && i?.pe?.value
          ) {
            resolve({
              id:     event.id,
              status: 'ok',
              gwp:    mid(i.gwp.value),
              wcf:    mid(i.wcf.value),
              energy: mid(i.energy.value),
              adpe:   mid(i.adpe.value),
              pe:     mid(i.pe.value),
            });
          } else {
            logError(`EcoLogits: no impact data for model '${event.model}'`);
            resolve({ id: event.id, status: 'no-data' });
          }
        } catch (e) {
          logError(`EcoLogits: failed to parse API response: ${e}`);
          resolve({ id: event.id, status: 'api-error' });
        }
      });
    });

    req.setTimeout(8000, () => { req.destroy(); resolve({ id: event.id, status: 'api-error' }); });
    req.on('error', (e: Error) => {
      logError(`EcoLogits: API request error for model '${event.model}': ${e.message}`);
      resolve({ id: event.id, status: 'api-error' });
    });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Sequential processing queue
// ---------------------------------------------------------------------------

export class EcoLogitsQueue {
  private readonly _inFlight = new Set<string>();
  private _processing = false;
  private readonly _queue: Array<{
    event: ResponseEvent;
    zone: string;
    apiUrl: string;
    onDone: (result: ImpactResult) => void;
  }> = [];

  enqueue(
    event: ResponseEvent,
    zone: string,
    apiUrl: string,
    onDone: (result: ImpactResult) => void,
  ): void {
    if (this._inFlight.has(event.id)) return;
    this._inFlight.add(event.id);
    this._queue.push({ event, zone, apiUrl, onDone });
    this._drain();
  }

  private _drain(): void {
    if (this._processing || this._queue.length === 0) return;
    this._processing = true;
    const item = this._queue.shift()!;
    fetchImpacts(item.event, item.zone, item.apiUrl)
      .then(result => {
        // Persist immediately so other windows can reuse
        appendImpact(result);
        item.onDone(result);
      })
      .catch(() => {
        const fallback: ImpactResult = { id: item.event.id, status: 'api-error' };
        appendImpact(fallback);
        item.onDone(fallback);
      })
      .finally(() => {
        this._inFlight.delete(item.event.id);
        this._processing = false;
        this._drain();
      });
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function appendImpact(result: ImpactResult): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    appendAndTrim(IMPACTS_FILE, JSON.stringify(result) + '\n');
  } catch (e) {
    logError(`appendImpact: ${e}`);
  }
}
