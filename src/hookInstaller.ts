import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOOKS_FILE       = path.join(os.homedir(), '.cursor', 'hooks.json');
const ECOLOGITS_MARKER = 'ecologits'; // substring used to identify our entries

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
// Managed hook table
//
// Each entry describes one hook we own.  `requiredFn` is called at install
// time to decide whether this hook should be active; when it returns false the
// entry is removed (not just skipped).
// ---------------------------------------------------------------------------

interface ManagedHook {
  /** Cursor hook event name */
  event: string;
  /** JS file name inside hook/ */
  script: string;
  /** Timeout (seconds) passed to Cursor */
  timeout: number;
  /** Returns true when this hook should be installed */
  required: () => boolean;
}

function managedHooks(): ManagedHook[] {
  const nudgeEnabled = vscode.workspace
    .getConfiguration('ecologitsCursor')
    .get<boolean>('nudge.enabled', true);

  return [
    { event: 'afterAgentResponse',  script: 'capture.js', timeout: 10, required: () => true },
    { event: 'beforeSubmitPrompt',  script: 'route.js',   timeout: 5,  required: () => nudgeEnabled },
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readHooksJson(): HooksJson {
  if (!fs.existsSync(HOOKS_FILE)) {
    return { version: 1, hooks: {} };
  }
  try {
    const raw    = fs.readFileSync(HOOKS_FILE, 'utf8');
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

/** Build the node command string for a given hook script. */
function buildCommand(context: vscode.ExtensionContext, script: string): string {
  const nodePath = vscode.workspace
    .getConfiguration('ecologitsCursor')
    .get<string>('nodePath', 'node');

  // Use forward slashes — Cursor's hook runner on Windows handles them.
  const scriptPath = path.join(context.extensionPath, 'hook', script)
    .replace(/\\/g, '/');

  return `${nodePath} "${scriptPath}"`;
}

/**
 * Remove all entries for the given event whose command contains the marker.
 * If the event array becomes empty, delete the key entirely.
 */
function removeEcologitsEntries(data: HooksJson, event: string): void {
  const entries = data.hooks[event];
  if (!Array.isArray(entries)) return;
  data.hooks[event] = entries.filter(e => !e.command.includes(ECOLOGITS_MARKER));
  if (data.hooks[event].length === 0) {
    delete data.hooks[event];
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function installHook(context: vscode.ExtensionContext): void {
  const data  = readHooksJson();
  const hooks = managedHooks();

  for (const h of hooks) {
    // Always remove stale entries first (covers path changes after VSIX update).
    removeEcologitsEntries(data, h.event);

    if (!h.required()) {
      // Hook is intentionally disabled — leave it absent.
      continue;
    }

    if (!Array.isArray(data.hooks[h.event])) {
      data.hooks[h.event] = [];
    }

    data.hooks[h.event].push({
      command: buildCommand(context, h.script),
      timeout: h.timeout,
    });
  }

  writeHooksJson(data);
}

export function uninstallHook(): void {
  if (!fs.existsSync(HOOKS_FILE)) return;
  const data  = readHooksJson();
  const hooks = managedHooks();
  for (const h of hooks) {
    removeEcologitsEntries(data, h.event);
  }
  writeHooksJson(data);
}

/**
 * Called on extension activation.
 *
 * - If all required entries exist and already point at the right paths, do
 *   nothing.
 * - If an entry exists but points at a different path (e.g. after a VSIX
 *   update), silently rewrite it.
 * - If a required entry is missing entirely, show a one-time information
 *   message with an "Install hook" button.  Never write the file without the
 *   user's consent the first time.
 * - If nudging is disabled, silently remove the route.js entry (if present).
 */
export function checkHookOnActivate(context: vscode.ExtensionContext): void {
  const data  = readHooksJson();
  const hooks = managedHooks();

  let needsWrite  = false;
  let missingAny  = false;

  for (const h of hooks) {
    const entries  = data.hooks[h.event] ?? [];
    const existing = entries.find(e => e.command.includes(ECOLOGITS_MARKER));
    const expected = buildCommand(context, h.script);

    if (!h.required()) {
      // Make sure any stale entry is removed silently.
      if (existing) {
        removeEcologitsEntries(data, h.event);
        needsWrite = true;
      }
      continue;
    }

    if (existing) {
      if (existing.command !== expected) {
        // Path changed after VSIX update — silently update.
        existing.command = expected;
        needsWrite = true;
      }
      // Entry is current — nothing to do.
    } else {
      missingAny = true;
    }
  }

  if (needsWrite) {
    writeHooksJson(data);
    // Cursor loads hooks.json at startup — before extensions activate — so any
    // change we just wrote won't take effect until the window is reloaded.
    vscode.window
      .showInformationMessage(
        'EcoLogits: Hook configuration changed. Reload Cursor for it to take effect.',
        'Reload Window',
        'Later',
      )
      .then(choice => {
        if (choice === 'Reload Window') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }, () => { /* ignore */ });
  }

  if (missingAny) {
    // Prompt the user once; don't write without consent.
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
}
