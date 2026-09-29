import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOOKS_FILE  = path.join(os.homedir(), '.cursor', 'hooks.json');
const ECOLOGITS_MARKER = 'ecologits'; // substring used to identify our entry

interface HookDefinition {
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface HooksJson {
  version: number;
  hooks: Record<string, HookDefinition[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHooksJson(): HooksJson {
  if (!fs.existsSync(HOOKS_FILE)) {
    return { version: 1, hooks: {} };
  }
  try {
    const raw = fs.readFileSync(HOOKS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as HooksJson;
    if (typeof parsed.version !== 'number') parsed.version = 1;
    if (typeof parsed.hooks !== 'object' || parsed.hooks === null) parsed.hooks = {};
    return parsed;
  } catch {
    // Unreadable/malformed — start fresh but keep a backup
    const backup = `${HOOKS_FILE}.bak`;
    try { fs.copyFileSync(HOOKS_FILE, backup); } catch { /* ignore */ }
    return { version: 1, hooks: {} };
  }
}

function writeHooksJson(data: HooksJson): void {
  fs.mkdirSync(path.dirname(HOOKS_FILE), { recursive: true });
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/** Build the node command string for the capture hook. */
function buildCommand(context: vscode.ExtensionContext): string {
  const nodePath = vscode.workspace
    .getConfiguration('ecologitsCursor')
    .get<string>('nodePath', 'node');

  // Use forward slashes — Cursor's hook runner on Windows handles them.
  const scriptPath = path.join(context.extensionPath, 'hook', 'capture.js')
    .replace(/\\/g, '/');

  return `${nodePath} "${scriptPath}"`;
}

/** Remove all afterAgentResponse entries whose command contains the marker. */
function removeEcologitsEntries(data: HooksJson): void {
  const entries = data.hooks['afterAgentResponse'];
  if (!Array.isArray(entries)) return;
  data.hooks['afterAgentResponse'] = entries.filter(
    e => !e.command.includes(ECOLOGITS_MARKER),
  );
  if (data.hooks['afterAgentResponse'].length === 0) {
    delete data.hooks['afterAgentResponse'];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function installHook(context: vscode.ExtensionContext): void {
  const data = readHooksJson();
  removeEcologitsEntries(data);

  const newEntry: HookDefinition = {
    command: buildCommand(context),
    timeout: 10,
  };

  if (!Array.isArray(data.hooks['afterAgentResponse'])) {
    data.hooks['afterAgentResponse'] = [];
  }
  data.hooks['afterAgentResponse'].push(newEntry);

  writeHooksJson(data);
}

export function uninstallHook(): void {
  if (!fs.existsSync(HOOKS_FILE)) return;
  const data = readHooksJson();
  removeEcologitsEntries(data);
  writeHooksJson(data);
}

/**
 * Called on extension activation.
 *
 * - If an ecologits entry exists but points at a different path (e.g. after a
 *   VSIX update where the version is part of the extension folder name),
 *   silently rewrite it.
 * - If no entry exists, show a one-time information message with an
 *   "Install hook" button. Never write the file without the user's consent
 *   the first time.
 */
export function checkHookOnActivate(context: vscode.ExtensionContext): void {
  const data = readHooksJson();
  const entries = data.hooks['afterAgentResponse'] ?? [];
  const existing = entries.find(e => e.command.includes(ECOLOGITS_MARKER));

  const expectedCommand = buildCommand(context);

  if (existing) {
    if (existing.command !== expectedCommand) {
      // Path changed (VSIX update) — silently update.
      existing.command = expectedCommand;
      writeHooksJson(data);
    }
    // Hook is installed and current — nothing to do.
    return;
  }

  // No entry found — prompt once.
  vscode.window
    .showInformationMessage(
      'EcoLogits: The Cursor capture hook is not installed. Install it to start tracking environmental impact.',
      'Install hook',
      'Dismiss',
    )
    .then(choice => {
      if (choice === 'Install hook') {
        installHook(context);
        vscode.window.showInformationMessage(
          'EcoLogits: Hook installed. Reload Cursor (or restart the hooks) for it to take effect.',
        );
      }
    }, () => { /* ignore */ });
}
