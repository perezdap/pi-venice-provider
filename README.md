# pi-venice-provider

A [pi](https://github.com/earendil-works/pi-mono) extension that registers
**venice.ai** as a model provider, backed by Venice's OpenAI-compatible Chat
Completions API (`https://api.venice.ai/api/v1`).

## Features

- **Runtime model discovery.** The text catalog — context window, max output
  tokens, cache/long-context pricing, and capabilities — is discovered from
  Venice's `/models?type=text` endpoint, so the provider does not pin a rotating
  model list.
- **Stable Venice trait selectors.** `/models/traits?type=text` is also resolved
  at runtime, exposing entries such as `venice/default_code`,
  `venice/default_reasoning`, and `venice/default_vision` alongside concrete
  model IDs.
- **`/login venice` support.** Prompts for and stores your Venice API key, with
  `VENICE_API_KEY` as an automatic fallback.
- **Requests sent exactly as Venice expects:**
  - `Authorization: Bearer <key>`
  - `developer` role support, as documented by Venice's chat schema
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
  - Streamed `reasoning_content` and structured `reasoning_details` are handled
    by the built-in `openai-completions` API
  - Prompt-cache read/write rates and long-context pricing tiers are mapped
    from the catalog; cache-capable models use Venice's supported
    `cache_control` content markers

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
/model venice/<id>   # pick a live ID or stable trait, e.g. venice/default_code
```

Set pi's default model in `settings.json` if desired:

```jsonc
{ "defaultProvider": "venice", "defaultModel": "default_code" }
```

To pick up newly added Venice models, run `/reload` (the factory re-fetches
`/models`).

## How it works

- **Streaming/API:** uses pi's built-in `openai-completions` API. Venice is
  OpenAI-compatible, so no custom streaming code is needed; pi already parses
  `reasoning_content`, tool calls, usage, and `stop` reasons.
- **Auth:** `envApiKeyAuth("Venice API key", ["VENICE_API_KEY"])` — stored
  credential wins, then `VENICE_API_KEY` env var.
- **Model discovery:** `GET /models?type=text` plus
  `GET /models/traits?type=text`, filtered to non-offline, non-beta text models
  with function calling that do not require Venice's E2EE transport handshake.
  Trait entries are aliases whose request model ID remains the trait, allowing
  Venice to resolve the current target.
- **Venice parameters:** injected via a `before_provider_request` handler
  scoped to `provider === "venice"`.

## Notes

- Venice's public discovery endpoints load before `/login`; chat requests still
  require an API key. This provider currently supports Bearer-key auth, not
  Venice's optional x402 wallet flow.
- This is intentionally a pi **chat provider**, not a client for every Venice
  API surface. It handles text chat models (including image input where pi
  supports it); Venice's standalone image, audio, video, embeddings, Responses,
  augment, billing, crypto RPC, E2EE handshake, and media quote/queue endpoints
  are outside its scope. E2EE-only and non-tool-calling models are therefore
  omitted from the coding-agent picker.
- Pi's message model currently advertises text/image inputs only. Venice models
  with audio, video, or file input remain selectable for text chat, but those
  additional input modalities are not exposed by this extension.
