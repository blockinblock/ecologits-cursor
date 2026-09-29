import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ImpactResult } from './ecologits';

const DATA_DIR    = path.join(os.homedir(), '.cursor', 'ecologits');
const RESPONSES_FILE = path.join(DATA_DIR, 'responses.jsonl');
const IMPACTS_FILE   = path.join(DATA_DIR, 'impacts.jsonl');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResponseEvent {
  id:              string;
  ts:              string;
  conversationId:  string;
  generationId:    string;
  model:           string;
  modelParams:     Array<{ id: string; value: string }>;
  outputTokens:    number;
  workspaceRoots:  string[];
  summary:         string;
}

export interface AggregatedImpacts {
  gwp:    number;
  wcf:    number;
  energy: number;
  adpe:   number;
  pe:     number;
  count:              number;
  outputTokensTotal:  number;
  pendingCount:       number;
  unsupportedCount:   number;
  models:             Set<string>;
  latestTs:           string;
}

// ---------------------------------------------------------------------------
// Root path normalisation
// ---------------------------------------------------------------------------

export function normalizeRoot(p: string): string {
  // On Windows, Cursor may send paths as /c:/Dev/SSP — strip the leading slash.
  let norm = p.replace(/^\/([a-zA-Z]:)/, '$1');
  // Forward slashes only
  norm = norm.replace(/\\/g, '/');
  // Remove trailing slash
  norm = norm.replace(/\/$/, '');
  // Lowercase on Windows for case-insensitive comparison
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

export function isForWindow(event: ResponseEvent, windowRoots: string[]): boolean {
  const normWindow = windowRoots.map(normalizeRoot);
  return event.workspaceRoots.some(r => normWindow.includes(normalizeRoot(r)));
}

// ---------------------------------------------------------------------------
// Incremental JSONL reader
// ---------------------------------------------------------------------------

class IncrementalReader<T> {
  private _offset = 0;

  constructor(private readonly _filePath: string) {}

  /** Read any new lines since the last call. Returns array of parsed objects. */
  readNew(): T[] {
    if (!fs.existsSync(this._filePath)) return [];
    const results: T[] = [];
    try {
      const size = fs.statSync(this._filePath).size;
      if (size < this._offset) {
        // File was truncated or replaced — start over
        this._offset = 0;
      }
      if (size === this._offset) return [];

      const fd = fs.openSync(this._filePath, 'r');
      try {
        const buf = Buffer.alloc(size - this._offset);
        fs.readSync(fd, buf, 0, buf.length, this._offset);
        this._offset = size;
        const chunk = buf.toString('utf8').replace(/^\uFEFF/, ''); // strip BOM
        for (const line of chunk.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { results.push(JSON.parse(trimmed) as T); } catch { /* skip malformed */ }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch { /* file gone during read */ }
    return results;
  }

  reset(): void { this._offset = 0; }
}

// ---------------------------------------------------------------------------
// Store — joins responses and impacts, supports incremental refresh
// ---------------------------------------------------------------------------

export class Store {
  private readonly _responsesReader = new IncrementalReader<ResponseEvent>(RESPONSES_FILE);
  private readonly _impactsReader   = new IncrementalReader<ImpactResult>(IMPACTS_FILE);

  // Full in-memory maps
  private readonly _responses = new Map<string, ResponseEvent>();
  private readonly _impacts   = new Map<string, ImpactResult>();

  // IDs that arrived since the last readNew (for queueing new API calls)
  private _newResponseIds: string[] = [];

  /** Read any new lines from both files. Returns ids of new responses needing API calls. */
  refresh(): string[] {
    // Read new responses
    const newResp = this._responsesReader.readNew();
    for (const r of newResp) {
      if (!this._responses.has(r.id)) this._responses.set(r.id, r);
    }

    // Read new impacts
    const newImpacts = this._impactsReader.readNew();
    for (const i of newImpacts) {
      this._impacts.set(i.id, i);
    }

    // IDs that have a response but no impact yet
    const needsImpact = newResp
      .map(r => r.id)
      .filter(id => !this._impacts.has(id));

    return needsImpact;
  }

  /** All response IDs that still lack an impact (for backfill on startup). */
  backfill(): string[] {
    // Reload both files from the beginning for the startup scan
    const allResp = this._readAllLines<ResponseEvent>(RESPONSES_FILE);
    const allImps = this._readAllLines<ImpactResult>(IMPACTS_FILE);

    for (const r of allResp) this._responses.set(r.id, r);
    for (const i of allImps) this._impacts.set(i.id, i);

    return allResp
      .map(r => r.id)
      .filter(id => !this._impacts.has(id));
  }

  getResponse(id: string): ResponseEvent | undefined {
    return this._responses.get(id);
  }

  markImpact(result: ImpactResult): void {
    this._impacts.set(result.id, result);
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  allResponses(): ResponseEvent[] {
    return Array.from(this._responses.values());
  }

  /** Latest conversationId across given responses (by ts). */
  latestConversationId(responses: ResponseEvent[]): string | null {
    if (responses.length === 0) return null;
    return responses
      .slice()
      .sort((a, b) => b.ts.localeCompare(a.ts))[0]
      .conversationId;
  }

  aggregate(responses: ResponseEvent[]): AggregatedImpacts {
    const acc: AggregatedImpacts = {
      gwp: 0, wcf: 0, energy: 0, adpe: 0, pe: 0,
      count: 0, outputTokensTotal: 0,
      pendingCount: 0, unsupportedCount: 0,
      models: new Set(),
      latestTs: '',
    };

    for (const r of responses) {
      acc.count++;
      acc.outputTokensTotal += r.outputTokens;
      acc.models.add(r.model);
      if (!acc.latestTs || r.ts > acc.latestTs) acc.latestTs = r.ts;

      const impact = this._impacts.get(r.id);
      if (!impact) {
        acc.pendingCount++;
      } else if (impact.status === 'unsupported-model') {
        acc.unsupportedCount++;
      } else if (impact.status === 'ok' && impact.gwp !== undefined) {
        acc.gwp    += impact.gwp    ?? 0;
        acc.wcf    += impact.wcf    ?? 0;
        acc.energy += impact.energy ?? 0;
        acc.adpe   += impact.adpe   ?? 0;
        acc.pe     += impact.pe     ?? 0;
      }
      // api-error and no-data: counted in pendingCount for now (will retry)
    }

    return acc;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _readAllLines<T>(filePath: string): T[] {
    const results: T[] = [];
    if (!fs.existsSync(filePath)) return results;
    try {
      const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { results.push(JSON.parse(trimmed) as T); } catch { /* skip */ }
      }
    } catch { /* file gone */ }
    return results;
  }
}

// Export path constants for the extension to watch
export { RESPONSES_FILE, IMPACTS_FILE, DATA_DIR };
