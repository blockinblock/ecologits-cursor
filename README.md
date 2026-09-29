# EcoLogits status bar extension for Cursor

Shows the estimated environmental impact of your [Cursor](https://cursor.com) agent sessions in the status bar: greenhouse gas emissions (CO₂eq), water consumption, and energy consumption, powered by the [EcoLogits](https://ecologits.ai) API.

Adapted from [marmelab/ecologits-vscode](https://github.com/marmelab/ecologits-vscode) (MIT).

## How it works

```
Cursor agent response
  └─▶  afterAgentResponse hook  (capture.js — no network)
         └─▶  ~/.cursor/ecologits/responses.jsonl
                └─▶  extension host  ──POST──▶  EcoLogits API
                       └─▶  ~/.cursor/ecologits/impacts.jsonl
                              └─▶  status bar
```

1. A tiny `capture.js` hook ships inside the extension. It receives the model ID and output-token count from Cursor's hook system and writes one JSON line per agent response.
2. The extension reads new lines, calls the EcoLogits estimation API, caches results, and updates the status bar.
3. No data is sent to any third party except the public EcoLogits API (`api.ecologits.ai`). The data files live in `~/.cursor/ecologits/`.

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
| **last** | Last agent response only |
| **chat** | Current chat session (approximated by latest conversation ID) |
| **ws** | All sessions in the current workspace |
| **all** | All time, all workspaces |

## Settings

| Setting | Default | Description |
|---|---|---|
| `ecologitsCursor.mode` | `workspace` | Active display mode |
| `ecologitsCursor.metrics` | `gwp wcf energy` | Space-separated metrics to show: `gwp`, `wcf`, `energy`, `adpe`, `pe`, `model` |
| `ecologitsCursor.zone` | `WOR` | Electricity-mix zone (ISO-3166 alpha-3, e.g. `DEU`, `FRA`) |
| `ecologitsCursor.api` | `https://api.ecologits.ai/v1beta/estimations` | EcoLogits API endpoint |
| `ecologitsCursor.nodePath` | `node` | Absolute path to `node` if it is not on Cursor's PATH (common on macOS with Dock launch) |

## Build and install

Requirements: Node.js ≥ 18, npm.

```bash
cd C:\Dev\ecologits-cursor
npm install
npm run package          # produces ecologits-cursor-0.1.0.vsix
```

Install in Cursor:

1. Open the Command Palette (`Ctrl+Shift+P`).
2. Run **Extensions: Install from VSIX…**
3. Select the generated `.vsix` file.
4. Reload Cursor when prompted.

## Hook setup

On first activation the extension prompts you to install the capture hook. You can also run it manually:

- **EcoLogits: Install Cursor hook** — adds the `afterAgentResponse` entry to `~/.cursor/hooks.json`.
- **EcoLogits: Uninstall Cursor hook** — removes it.

The hook entry looks like this:

```json
{
  "afterAgentResponse": [
    {
      "command": "node \"/path/to/extension/hook/capture.js\"",
      "timeout": 10
    }
  ]
}
```

The extension automatically updates the path whenever the extension folder changes (e.g. after a VSIX update).

## Data files

| File | Writer | Content |
|---|---|---|
| `~/.cursor/ecologits/responses.jsonl` | `capture.js` | One line per agent response: model, tokens, workspace, summary |
| `~/.cursor/ecologits/impacts.jsonl` | Extension | One line per computed impact: gwp, wcf, energy, adpe, pe |
| `~/.cursor/ecologits/error.log` | `capture.js` | Errors from the hook script |

## Proxy support

The API call runs in the Cursor extension host, which picks up your system proxy settings. If it doesn't work on your corporate network, set the proxy explicitly in VS Code/Cursor settings (`http.proxy`).

## License

MIT — see [LICENSE](LICENSE).  
Original work © 2024 Marmelab.
