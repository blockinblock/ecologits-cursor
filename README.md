# EcoLogits status bar extension for Cursor

Shows the estimated environmental impact of your [Cursor](https://cursor.com) agent sessions in the status bar (CO₂eq, water, energy), powered by the [EcoLogits](https://ecologits.ai) API. Optionally nudges you to use a smaller model for simple prompts.

Adapted from [marmelab/ecologits-vscode](https://github.com/marmelab/ecologits-vscode) (MIT).

## How it works

```
User sends a prompt
  └─▶ beforeSubmitPrompt hook (route.js, local Ollama only)
        └─▶ simple prompt on a large model?
              ├─ yes → nudge message, prompt blocked
              └─ no  → continue: true

Agent response
  └─▶ afterAgentResponse hook (capture.js, no network)
        └─▶ ~/.cursor/ecologits/responses.jsonl
              └─▶ extension host ──POST──▶ EcoLogits API
                    └─▶ ~/.cursor/ecologits/impacts.jsonl
                          └─▶ status bar
```

1. `route.js` runs before each prompt is submitted. It detects questions a smaller model could answer and blocks them with a message suggesting a model switch. It allows the prompt on any error. An internal watchdog (SLM timeout + 1 s, so 2 s by default) fires before Cursor's 5 s hook timeout. No prompt text is stored.
2. `capture.js` runs after each agent response and writes one JSON line with the model ID and output-token count.
3. The extension reads new lines, calls the EcoLogits API, caches results, and updates the status bar.

The only external service contacted is the public EcoLogits API (`api.ecologits.ai`); the only other network traffic is `route.js` and the extension talking to your local Ollama.

## Prompt nudge

When `ecologitsCursor.nudge.enabled` is `true`, `route.js` may block a prompt with a suggestion to switch to a smaller model.

**Always allowed if:**

- It starts with `!big` (explicit override; the full prompt including `!big` is sent to the model).
- The selected model looks small (name contains `mini`, `nano`, `flash`, `haiku`, `lite`, `small`, or `composer`).
- It is longer than 500 characters.
- More than one file is attached.
- A fenced code block spans 15 or more lines.
- It contains a complex keyword: `refactor`, `implement`, `architect`, `migrate`, `debug`, `fix`, `across`, `codebase`, `all files`, `write tests`, `optimize`, `design`.
- It has more than 4 sentence-ending punctuation marks or bullet points.

**Otherwise nudged if:**

- It starts with `what`, `how do i`, `how to`, `explain`, `why`, `syntax`, `rename`, `translate`, `convert`, `regex`, or `difference between`.
- Or it is 120 characters or shorter.

### Local SLM classifier (Ollama + Gemma 3 270M)

By default (`ecologitsCursor.nudge.classifier = slm`) the final simple/complex judgement is made by a small local model (`gemma3:270m`, about 0.3 GB) served by [Ollama](https://ollama.com). The `!big` override, small-model check and the "always allowed" rules above run first, so those prompts never reach the model. Only a "simple" verdict nudges. If Ollama is unreachable, slow (default timeout 1000 ms), or returns bad output, `route.js` falls back to the heuristics. Set the classifier to `heuristic` to never call the model.

On the bundled 40-prompt benchmark (`node scripts/bench-slm.js`) the model reaches about 95% accuracy with a warm latency of roughly 170 to 220 ms, versus 65% for the heuristics alone. The first call after the model is unloaded takes a few seconds, which exceeds the timeout, so that prompt falls back to the heuristics.

**Setup**

1. Install Ollama (per user, no admin rights needed) from [ollama.com](https://ollama.com). It serves `http://127.0.0.1:11434`.
2. Run `ollama pull gemma3:270m` (or set `ecologitsCursor.nudge.slm.model` to another installed tag).
3. Run **EcoLogits: Check local prompt classifier** from the Command Palette to verify Ollama, the model, and latency.

**Windows locations:** binaries in `%LOCALAPPDATA%\Programs\Ollama`, logs in `%LOCALAPPDATA%\Ollama`, models in `%USERPROFILE%\.ollama\models` (override with the `OLLAMA_MODELS` environment variable, e.g. `D:\ollama\models`). On macOS and Linux models default to `~/.ollama/models`, with the same override.


**Privacy:** the first ~1000 characters of the prompt are sent only to the Ollama endpoint, and only loopback endpoints (`127.0.0.1`, `localhost`, `::1`) are accepted. The extension writes its settings to `~/.cursor/ecologits/route-config.json`, which the hook reads on every run.

## Supported models

| Provider  | Patterns matched                                        |
| --------- | ------------------------------------------------------- |
| Anthropic | `claude-*`                                              |
| OpenAI    | `gpt-*`, `o1`, `o3`, …                                  |
| Google    | `gemini-*`, `gemma-*`                                   |
| Mistral   | `mistral-*`, `codestral-*`, `magistral-*`, `devstral-*` |

Other models (Auto, Composer, unknown) are counted as unsupported and the count is shown in the tooltip.

## Display modes

Click the status bar item to cycle through modes:

| Mode        | What it shows                                                 |
| ----------- | ------------------------------------------------------------- |
| `lastUse`   | Last agent response only                                      |
| `chat`      | Current chat session (approximated by latest conversation ID) |
| `workspace` | All sessions in the current workspace                         |
| `allTime`   | All workspaces                                                |

> **Note:** only the most recent 100 entries are kept (see [Data files](#data-files)), so `workspace` and `allTime` cover at most roughly the last 100 agent responses.

## Settings

| Setting                               | Default                                       | Description                                                                                                                                                      |
| ------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ecologitsCursor.mode`                | `workspace`                                   | Active display mode                                                                                                                                              |
| `ecologitsCursor.metrics`             | `gwp wcf energy`                              | Space-separated metrics: `gwp`, `wcf`, `energy`, `adpe`, `pe`, `model`                                                                                           |
| `ecologitsCursor.zone`                | `WOR`                                         | Electricity-mix zone (ISO-3166 alpha-3, e.g. `DEU`, `FRA`)                                                                                                       |
| `ecologitsCursor.api`                 | `https://api.ecologits.ai/v1beta/estimations` | EcoLogits API endpoint                                                                                                                                           |
| `ecologitsCursor.nodePath`            | `node`                                        | Absolute path to `node` if it is not on Cursor's PATH (common on macOS with Dock launch)                                                                         |
| `ecologitsCursor.nudge.enabled`       | `true`                                        | Block prompts that look simple and suggest a smaller model. Updates `~/.cursor/hooks.json` immediately; reload the window, since Cursor reads hooks at startup. |
| `ecologitsCursor.nudge.classifier`    | `slm`                                         | `slm` (local Ollama, heuristic fallback) or `heuristic`                                                                                                          |
| `ecologitsCursor.nudge.slm.endpoint`  | `http://127.0.0.1:11434`                      | Ollama endpoint (loopback only)                                                                                                                                  |
| `ecologitsCursor.nudge.slm.model`     | `gemma3:270m`                                 | Ollama model tag                                                                                                                                                 |
| `ecologitsCursor.nudge.slm.timeoutMs` | `1000`                                        | SLM request timeout; keep below 3500 (the watchdog fires 1 s later and Cursor's hook timeout is 5 s)                                                             |

## Build and install

Requirements: Node.js ≥ 18, npm.

```bash
npm install
npm run package   # produces ecologits-cursor-0.1.0.vsix
npm test          # compiles, then runs the node:test suites (no extra deps)
```

Install in Cursor: Command Palette (`Ctrl+Shift+P`) → **Extensions: Install from VSIX…** → select the `.vsix` → reload when prompted.

## Hook setup

On first activation the extension offers to install the hooks. You can also run:

- **EcoLogits: Install Cursor hook** adds the hook entries to `~/.cursor/hooks.json`.
- **EcoLogits: Uninstall Cursor hook** removes them.

The entries look like this:

```json
{
  "version": 1,
  "hooks": {
    "afterAgentResponse": [
      { "command": "node \"/path/to/extension/hook/capture.js\"", "timeout": 10 }
    ],
    "beforeSubmitPrompt": [
      { "command": "node \"/path/to/extension/hook/route.js\"", "timeout": 5 }
    ]
  }
}
```

`beforeSubmitPrompt` is only written when `ecologitsCursor.nudge.enabled` is `true`. Hook paths are updated automatically when the extension folder changes (e.g. after a VSIX update).

## Data files

All files live in `~/.cursor/ecologits/`.

| File                | Writer                              | Content                                                                                                              |
| ------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `responses.jsonl`   | `capture.js`                        | Per agent response: model, tokens, workspace, conversation/generation IDs, short summary                             |
| `impacts.jsonl`     | Extension                           | Per computed impact: id, status (`ok`, `unsupported-model`, `api-error`, `no-data`), gwp, wcf, energy, adpe, pe      |
| `ecologits.log`     | `capture.js`, `route.js`, extension | Activity and errors from the hooks and EcoLogits API calls; each line is `timestamp [INFO\|ERROR] message`           |
| `route-config.json` | Extension                           | Classifier settings read by `route.js`                                                                               |

**Retention:** each log file is trimmed to its last 100 entries whenever a line is appended.

**Privacy:** the hooks store **no prompt text**. `capture.js` does store a `summary` in `responses.jsonl`: the first non-empty line of the agent's *response*, stripped of markdown and truncated to 100 characters. It stays on your machine. Only the provider, model name, output-token count and electricity zone are sent to the EcoLogits API.

## Proxy support

The API call runs in the Cursor extension host, which uses your system proxy settings. If that fails on a corporate network, set `http.proxy` in Cursor settings.

## License

MIT, see [LICENSE](LICENSE). Original work © 2024 Marmelab.
