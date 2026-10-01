# EcoLogits status bar extension for Cursor

Shows the estimated environmental impact of your [Cursor](https://cursor.com) agent sessions in the status bar: greenhouse gas emissions (CO₂eq), water consumption, and energy consumption, powered by the [EcoLogits](https://ecologits.ai) API.

Adapted from [marmelab/ecologits-vscode](https://github.com/marmelab/ecologits-vscode) (MIT).

## How it works

```
User sends a prompt
  └─▶  beforeSubmitPrompt hook  (route.js — no network)
         └─▶  simple prompt on a large model?
                ├─ yes → nudge message, prompt blocked
                └─ no  → continue: true

Cursor agent response
  └─▶  afterAgentResponse hook  (capture.js — no network)
         └─▶  ~/.cursor/ecologits/responses.jsonl
                └─▶  extension host  ──POST──▶  EcoLogits API
                       └─▶  ~/.cursor/ecologits/impacts.jsonl
                              └─▶  status bar
```

1. **`route.js`** — runs before each prompt is submitted. It applies simple heuristics to detect questions that a smaller model could handle just as well, and blocks them with a message suggesting a model switch. It allows the prompt on any error and has a 1.5-second internal watchdog (Cursor also enforces a 2-second timeout). No prompt text is stored; no network calls are made.
2. **`capture.js`** — runs after each agent response. It receives the model ID and output-token count from Cursor's hook system and writes one JSON line per agent response.
3. The extension reads new lines, calls the EcoLogits estimation API, caches results, and updates the status bar.
4. No data is sent to any third party except the public EcoLogits API (`api.ecologits.ai`). The data files live in `~/.cursor/ecologits/`.

## Prompt nudge heuristics

When `ecologitsCursor.nudge.enabled` is `true`, `route.js` classifies each prompt and may block it with a suggestion to switch to a smaller model.

**The prompt is always allowed if any of these are true:**
- It starts with `!big` (explicit override — Cursor will send the full prompt including `!big` to the model).
- The selected model already looks small (name contains `mini`, `nano`, `flash`, `haiku`, `lite`, `small`, or `composer`).
- The prompt is longer than 500 characters.
- More than one file is attached.
- A fenced code block spans 15 or more lines.
- The prompt contains a complex keyword: `refactor`, `implement`, `architect`, `migrate`, `debug`, `fix`, `across`, `codebase`, `all files`, `write tests`, `optimize`, `design`.
- There are more than 4 sentence-ending punctuation marks or bullet points.

**The prompt is nudged if:**
- It starts with a question word or topic prefix: `what`, `how do i`, `how to`, `explain`, `why`, `what is`, `syntax`, `rename`, `translate`, `convert`, `regex`, `difference between`.
- Or it is 120 characters or shorter (and no complex signal matched).

## Supported models

| Provider | Patterns matched |
|---|---|
| Anthropic | `claude-*` |
| OpenAI | `gpt-*`, `o1`, `o3`, … |
| Google | `gemini-*`, `gemma-*` |
| Mistral | `mistral-*`, `codestral-*`, `magistral-*`, `devstral-*` |

Other models (Auto, Composer, unknown) are counted as unsupported and show in the tooltip.

## Display modes

Click the status bar item to cycle through modes:

| Mode | What it shows |
|---|---|
| **lastUse** | Last agent response only |
| **chat** | Current chat session (approximated by latest conversation ID) |
| **workspace** | All sessions in the current workspace |
| **allTime** | All workspaces |

> **Note:** only the most recent 100 entries are retained in the data files (see [Data files](#data-files)), so **ws** and **all** cover at most roughly the last 100 agent responses, not a true all-time total.

## Settings

| Setting | Default | Description |
|---|---|---|
| `ecologitsCursor.mode` | `workspace` | Active display mode |
| `ecologitsCursor.metrics` | `gwp wcf energy` | Space-separated metrics to show: `gwp`, `wcf`, `energy`, `adpe`, `pe`, `model` |
| `ecologitsCursor.zone` | `WOR` | Electricity-mix zone (ISO-3166 alpha-3, e.g. `DEU`, `FRA`) |
| `ecologitsCursor.api` | `https://api.ecologits.ai/v1beta/estimations` | EcoLogits API endpoint |
| `ecologitsCursor.nodePath` | `node` | Absolute path to `node` if it is not on Cursor's PATH (common on macOS with Dock launch) |
| `ecologitsCursor.nudge.enabled` | `true` | Block prompts that look simple and suggest switching to a smaller model. Changing this setting updates `~/.cursor/hooks.json` immediately, but Cursor reads hooks at startup, so you may need to reload the window for it to take effect. |

## Build and install

Requirements: Node.js ≥ 18, npm.

```bash
cd C:\Dev\ecologits-cursor
npm install
npm run package          # produces ecologits-cursor-0.1.0.vsix
npm test                 # runs the route.js heuristic tests (node:test, no extra deps)
```

Install in Cursor:

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **Extensions: Install from VSIX…**
3. Select the generated `.vsix` file.
4. Reload Cursor when prompted.

## Hook setup

On first activation the extension prompts you to install the hooks. You can also run it manually:

- **EcoLogits: Install Cursor hook** — adds both hook entries to `~/.cursor/hooks.json`.
- **EcoLogits: Uninstall Cursor hook** — removes them.

The hook entries look like this:

```json
{
  "afterAgentResponse": [
    {
      "command": "node \"/path/to/extension/hook/capture.js\"",
      "timeout": 10
    }
  ],
  "beforeSubmitPrompt": [
    {
      "command": "node \"/path/to/extension/hook/route.js\"",
      "timeout": 2
    }
  ]
}
```

The `beforeSubmitPrompt` entry is only written when `ecologitsCursor.nudge.enabled` is `true`. Toggling the setting updates `hooks.json` immediately, but Cursor loads hooks at startup, so reload the window afterwards. The extension automatically updates both paths whenever the extension folder changes (e.g. after a VSIX update).

## Data files

| File | Writer | Content |
|---|---|---|
| `~/.cursor/ecologits/responses.jsonl` | `capture.js` | One line per agent response: model, tokens, workspace, conversation/generation IDs, and a short summary (see below) |
| `~/.cursor/ecologits/impacts.jsonl` | Extension | One line per computed impact: id, status (`ok`, `unsupported-model`, `api-error`, `no-data`), gwp, wcf, energy, adpe, pe |
| `~/.cursor/ecologits/error.log` | `capture.js`, `route.js`, extension | Errors from the hook scripts and from EcoLogits API calls |

**Retention:** each of these files is trimmed to its last 100 entries whenever a line is appended. Older data is discarded.

**Privacy:** the hooks store **no prompt text** and make **no network calls**. However, `capture.js` does store a `summary` in `responses.jsonl`: the first non-empty line of the agent's *response*, stripped of markdown and truncated to 100 characters. This stays on your machine; only the provider, model name, output-token count and electricity zone are sent to the EcoLogits API.

## Proxy support

The API call runs in the Cursor extension host, which picks up your system proxy settings. If it doesn't work on your corporate network, set the proxy explicitly in VS Code/Cursor settings (`http.proxy`).

## License

MIT — see [LICENSE](LICENSE).  
Original work © 2024 Marmelab.
