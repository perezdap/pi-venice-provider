# pi-venice-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that registers
**venice.ai** as a model provider, backed by Venice's OpenAI-compatible Chat
Completions API (`https://api.venice.ai/api/v1`).

## Features

- **Correct per-model context windows.** The full model catalog — context
  window, max output tokens, pricing, and capabilities — is discovered at
  startup from Venice's public `/models` endpoint, so every model's context
  window matches what Venice actually enforces.
- **`/login venice` support.** Prompts for and stores your Venice API key, with
  `VENICE_API_KEY` as an automatic fallback.
- **Requests sent exactly as Venice expects:**
  - `Authorization: Bearer <key>`
  - `system` role (so Venice's system-prompt handling applies)
  - `max_completion_tokens` (Venice's preferred field)
  - `reasoning_effort` mapped per model from Venice's `reasoningEffortOptions`
    (`off → "none"` when Venice offers it; `minimal/low/medium/high/xhigh/max →`
    the matching value; unsupported levels are hidden from the thinking selector).
    When a model does **not** list `"none"`, `off` stays selectable but no
    `reasoning_effort` is sent (sending an unsupported value makes Venice reject
    the request) — thinking is disabled via `disable_thinking` instead.
  - `venice_parameters.include_venice_system_prompt = false` so pi's system
    prompt is authoritative rather than appended to Venice's defaults
  - For reasoning models that can't express `off` via `reasoning_effort:"none"`
    (no `"none"` option, or no effort control), `venice_parameters.disable_thinking`
    is set when the thinking level is `off`
  - Streamed `reasoning_content` deltas are parsed into pi thinking blocks by
    the built-in `openai-completions` API

## Install

### As a pi package (recommended)

```sh
pi install git:github.com/perezdap/pi-venice-provider
```

This clones the repo and registers the extension from the `pi` manifest in
`package.json`. Run `pi update --extensions` to pick up new versions.

### Global (all projects), manual

Clone straight into pi's global extensions folder:

```sh
# Windows (PowerShell)
git clone https://github.com/perezdap/pi-venice-provider "$env:USERPROFILE\.pi\agent\extensions\venice"

# macOS / Linux
git clone https://github.com/perezdap/pi-venice-provider ~/.pi/agent/extensions/venice
```

Then start (or `/reload`) pi. The extension auto-loads from
`~/.pi/agent/extensions/venice/index.ts`.

### Project-local

Clone into `<project>/.pi/extensions/venice/` instead. Project-local extensions
load only after the project is trusted.

### Quick test (no install)

```sh
pi -e ./index.ts
```

## Use

```
/login venice        # enter your Venice API key (or export VENICE_API_KEY first)
/model venice/<id>   # pick a model, e.g. venice/zai-org-glm-5-1
```

Set pi's default model in `settings.json` if desired:

```jsonc
{ "defaultProvider": "venice", "defaultModel": "zai-org-glm-5-1" }
```

To pick up newly added Venice models, run `/reload` (the factory re-fetches
`/models`).

## How it works

- **Streaming/API:** uses pi's built-in `openai-completions` API. Venice is
  OpenAI-compatible, so no custom streaming code is needed; pi already parses
  `reasoning_content`, tool calls, usage, and `stop` reasons.
- **Auth:** `envApiKeyAuth("Venice API key", ["VENICE_API_KEY"])` — stored
  credential wins, then `VENICE_API_KEY` env var.
- **Model discovery:** `GET https://api.venice.ai/api/v1/models` (no auth
  required), filtered to `type === "text"` and non-offline models.
- **Venice parameters:** injected via a `before_provider_request` handler
  scoped to `provider === "venice"`.

## Notes

- Venice's `/models` endpoint requires no auth, so models load even before you
  run `/login`. Requests, however, need a key.
- This extension only handles text (chat-completion) models. Venice's image,
  audio, and video endpoints are not wired up here.
