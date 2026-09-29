import * as vscode from 'vscode';
import * as fs from 'fs';
import { Store, isForWindow, DATA_DIR, type AggregatedImpacts, type ResponseEvent } from './store';
import { EcoLogitsQueue } from './ecologits';
import { fmtGwp, fmtWcf, fmtEnergy, fmtAdpe, fmtPe } from './format';
import { checkHookOnActivate, installHook, uninstallHook } from './hookInstaller';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const MODES = ['lastUse', 'chat', 'workspace', 'allTime'] as const;
type Mode = typeof MODES[number];

const MODE_SUFFIX: Record<Mode, string> = {
  lastUse:   '· last',
  chat:      '· chat',
  workspace: '· ws',
  allTime:   '· all',
};

const MODE_TOOLTIP: Record<Mode, string> = {
  lastUse:   'Last response only — click to change mode',
  chat:      'Current chat session — click to change mode',
  workspace: 'This workspace, all sessions — click to change mode',
  allTime:   'All time, all projects — click to change mode',
};

// ---------------------------------------------------------------------------
// Metric rendering
// ---------------------------------------------------------------------------

function renderMetric(
  key: string,
  agg: AggregatedImpacts | null,
  models: string,
): string {
  if (!agg) return '';
  switch (key) {
    case 'gwp':    return `🔥 ${fmtGwp(agg.gwp)}`;
    case 'wcf':    return `💧 ${fmtWcf(agg.wcf)}`;
    case 'energy': return `⚡ ${fmtEnergy(agg.energy)}`;
    case 'adpe':   return `⛏ ${fmtAdpe(agg.adpe)}`;
    case 'pe':     return `🛢 ${fmtPe(agg.pe)}`;
    case 'model':  return `🤖 ${models}`;
    default:       return '';
  }
}

function buildStatusText(agg: AggregatedImpacts | null, metrics: string[], mode: Mode): string {
  if (!agg || agg.count === 0) return `🌱 EcoLogits ${MODE_SUFFIX[mode]}`;
  const modelLabel = agg.models.size > 0
    ? Array.from(agg.models).map(m => m.replace(/^claude-/, '')).join(', ')
    : '';
  const parts = metrics
    .map(k => renderMetric(k, agg, modelLabel))
    .filter(Boolean);
  return `${parts.join(' | ')} ${MODE_SUFFIX[mode]}`.trimEnd();
}

function buildTooltip(agg: AggregatedImpacts | null, mode: Mode): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.isTrusted = false;
  md.appendText(MODE_TOOLTIP[mode]);

  if (!agg || agg.count === 0) {
    md.appendText('\n\nNo data yet — send an agent message to start tracking.');
    return md;
  }

  md.appendMarkdown('\n\n');
  md.appendMarkdown(`**Responses:** ${agg.count} | **Tokens:** ${agg.outputTokensTotal.toLocaleString()}\n\n`);
  if (agg.models.size > 0) {
    md.appendMarkdown(`**Models:** ${Array.from(agg.models).join(', ')}\n\n`);
  }
  md.appendMarkdown('| Metric | Value |\n|---|---|\n');
  md.appendMarkdown(`| 🔥 GHG (CO₂eq) | ${fmtGwp(agg.gwp)} |\n`);
  md.appendMarkdown(`| 💧 Water       | ${fmtWcf(agg.wcf)} |\n`);
  md.appendMarkdown(`| ⚡ Energy      | ${fmtEnergy(agg.energy)} |\n`);
  md.appendMarkdown(`| ⛏ Minerals    | ${fmtAdpe(agg.adpe)} |\n`);
  md.appendMarkdown(`| 🛢 Primary E.  | ${fmtPe(agg.pe)} |\n`);

  if (agg.pendingCount > 0) {
    md.appendMarkdown(`\n*${agg.pendingCount} response(s) pending API result*`);
  }
  if (agg.unsupportedCount > 0) {
    md.appendMarkdown(`\n*${agg.unsupportedCount} response(s) from unsupported model(s)*`);
  }
  if (agg.latestTs) {
    const d = new Date(agg.latestTs);
    md.appendMarkdown(`\n\nLast: ${d.toLocaleString()}`);
  }
  return md;
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

let watcher: fs.FSWatcher | null = null;

export function activate(context: vscode.ExtensionContext): void {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'ecologitsCursor.cycleMode';
  statusBar.text = '🌱 EcoLogits';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const store = new Store();
  const queue = new EcoLogitsQueue();
  const windowRoots = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);

  // ---------------------------------------------------------------------------
  // Config helpers
  // ---------------------------------------------------------------------------

  function cfg(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('ecologitsCursor');
  }

  function currentMode(): Mode {
    const m = cfg().get<string>('mode') ?? 'workspace';
    return (MODES as readonly string[]).includes(m) ? m as Mode : 'workspace';
  }

  function metrics(): string[] {
    return (cfg().get<string>('metrics') ?? 'gwp wcf energy').trim().split(/\s+/);
  }

  function zone(): string    { return cfg().get<string>('zone') ?? 'WOR'; }
  function apiUrl(): string  { return cfg().get<string>('api')  ?? 'https://api.ecologits.ai/v1beta/estimations'; }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  let currentAgg: AggregatedImpacts | null = null;

  // ---------------------------------------------------------------------------
  // Repaint
  // ---------------------------------------------------------------------------

  function repaint(): void {
    const mode = currentMode();
    statusBar.text    = buildStatusText(currentAgg, metrics(), mode);
    statusBar.tooltip = buildTooltip(currentAgg, mode);
  }

  // ---------------------------------------------------------------------------
  // Select responses to aggregate based on active mode
  // ---------------------------------------------------------------------------

  function selectResponses(): ResponseEvent[] {
    const mode = currentMode();
    let all = store.allResponses();

    if (mode !== 'allTime') {
      // Filter to this window
      all = all.filter(r => isForWindow(r, windowRoots));
    }

    if (mode === 'lastUse') {
      // Most recent single response for this window
      if (all.length === 0) return [];
      all.sort((a, b) => b.ts.localeCompare(a.ts));
      return [all[0]];
    }

    if (mode === 'chat') {
      const latestConvId = store.latestConversationId(all);
      if (!latestConvId) return [];
      return all.filter(r => r.conversationId === latestConvId);
    }

    return all; // workspace or allTime
  }

  // ---------------------------------------------------------------------------
  // Refresh cycle
  // ---------------------------------------------------------------------------

  let debounce: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(): void {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => refresh(), 300);
  }

  function refresh(): void {
    const newIds = store.refresh();

    // Queue API calls for new responses from this window (or all in allTime mode)
    const needsCall = newIds
      .map(id => store.getResponse(id))
      .filter((r): r is ResponseEvent => {
        if (!r) return false;
        return currentMode() === 'allTime' || isForWindow(r, windowRoots);
      });

    for (const r of needsCall) {
      queue.enqueue(r, zone(), apiUrl(), result => {
        store.markImpact(result);
        currentAgg = store.aggregate(selectResponses());
        repaint();
      });
    }

    currentAgg = store.aggregate(selectResponses());
    repaint();
  }

  // ---------------------------------------------------------------------------
  // Startup backfill — fill impacts for events that arrived before this window
  // ---------------------------------------------------------------------------

  function backfill(): void {
    const missingIds = store.backfill();
    const allMode = currentMode() === 'allTime';

    const toFill = missingIds
      .map(id => store.getResponse(id))
      .filter((r): r is ResponseEvent => {
        if (!r) return false;
        return allMode || isForWindow(r, windowRoots);
      });

    for (const r of toFill) {
      queue.enqueue(r, zone(), apiUrl(), result => {
        store.markImpact(result);
        currentAgg = store.aggregate(selectResponses());
        repaint();
      });
    }

    currentAgg = store.aggregate(selectResponses());
    repaint();
  }

  // ---------------------------------------------------------------------------
  // Watcher
  // ---------------------------------------------------------------------------

  function startWatching(): void {
    watcher?.close();
    watcher = null;
    scheduleRefresh();

    try {
      // Ensure the data dir exists so we can watch it even before the first event
      fs.mkdirSync(DATA_DIR, { recursive: true });
      watcher = fs.watch(DATA_DIR, scheduleRefresh);
    } catch { /* inotify limit or dir not available — fallback poll covers it */ }
  }

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('ecologitsCursor.cycleMode', () => {
      const next = MODES[(MODES.indexOf(currentMode()) + 1) % MODES.length];
      cfg().update('mode', next, vscode.ConfigurationTarget.Global).then(
        () => scheduleRefresh(),
        () => scheduleRefresh(),
      );
    }),

    vscode.commands.registerCommand('ecologitsCursor.installHook', () => {
      installHook(context);
      vscode.window.showInformationMessage(
        'EcoLogits: Hook installed. Reload Cursor (or restart hooks) for it to take effect.',
      );
    }),

    vscode.commands.registerCommand('ecologitsCursor.uninstallHook', () => {
      uninstallHook();
      vscode.window.showInformationMessage('EcoLogits: Hook removed from ~/.cursor/hooks.json.');
    }),
  );

  // ---------------------------------------------------------------------------
  // React to settings changes
  // ---------------------------------------------------------------------------

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (!e.affectsConfiguration('ecologitsCursor')) return;
      if (e.affectsConfiguration('ecologitsCursor.mode')) {
        // Mode changed: re-aggregate and restart watcher
        startWatching();
      } else {
        repaint();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => startWatching()),
  );

  // ---------------------------------------------------------------------------
  // Fallback poll (30 s) — fs.watch can miss events on some setups
  // ---------------------------------------------------------------------------

  const poll = setInterval(scheduleRefresh, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(poll) });
  context.subscriptions.push({ dispose: () => { watcher?.close(); watcher = null; } });

  // ---------------------------------------------------------------------------
  // Startup
  // ---------------------------------------------------------------------------

  checkHookOnActivate(context);
  backfill();
  startWatching();
}

export function deactivate(): void {
  watcher?.close();
  watcher = null;
}
