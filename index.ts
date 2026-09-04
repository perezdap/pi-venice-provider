/**
 * Venice.ai provider extension for pi.
 *
 * Registers the "venice" provider against Venice's OpenAI-compatible Chat
 * Completions API (https://api.venice.ai/api/v1). The full model catalog —
 * including per-model context windows, max output tokens, pricing, and
 * capabilities — is discovered at runtime from Venice's public /models and
 * /models/traits endpoints, so context windows stay correct and stable trait
 * selectors such as default_code follow Venice's current routing.
 *
 * Auth: `/login venice` prompts for a Venice API key and stores it, with
 * $VENICE_API_KEY used as an automatic fallback. Chat requests are sent
 * exactly as Venice expects:
 *
 *   - `Authorization: Bearer <key>` (resolved by openai-completions + envApiKeyAuth)
 *   - `developer` role support, as documented by Venice's chat schema
 *   - `max_completion_tokens` (Venice's preferred field; `max_tokens` is deprecated)
 *   - `reasoning_effort` mapped per model from Venice's `reasoningEffortOptions`
 *     (off => "none", minimal/low/medium/high/xhigh/max => matching value,
 *     unsupported levels hidden)
 *   - `venice_parameters.include_venice_system_prompt = false` so pi's own
 *     system prompt is authoritative instead of being appended to Venice's
 *     defaults (injected via before_provider_request, scoped to this provider)
 *   - For reasoning models that do not expose effort control, thinking is
 *     turned off via `venice_parameters.disable_thinking = true` when the user
 *     selects the "off" thinking level
 *   - Streamed `reasoning_content` / `reasoning_details` are handled by pi's
 *     built-in openai-completions API (no custom streaming needed)
 *   - Prompt-cache read/write rates and long-context pricing tiers are mapped
 *     from the live catalog; cache-capable models declare supportsLongCacheRetention
 *     so pi can request prompt_cache_retention: "24h" when configured
 *
 * Usage:
 *   /login venice        # enter your Venice API key (or export VENICE_API_KEY)
 *   /model venice/<id>   # pick a live ID or stable trait, e.g. venice/default_code
 *
 * Models are refreshed by /reload (re-runs this factory, re-fetches /models).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createProvider,
	envApiKeyAuth,
	type Api,
	type Model,
	type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";

const PROVIDER_ID = "venice";
const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
const VENICE_MODELS_URL = "https://api.venice.ai/api/v1/models?type=text";
const VENICE_MODEL_TRAITS_URL = "https://api.venice.ai/api/v1/models/traits?type=text";

// pi thinking levels in increasing order of effort. Venice's "none" is pi's "off".
const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const DISCOVERY_TIMEOUT_MS = 15_000;

/**
 * Build a pi thinkingLevelMap from a Venice model's supported effort options.
 *
 * "off" disables thinking. When Venice lists "none" as an effort option we map
 * off -> "none" (sent as the OpenAI-compatible `reasoning_effort:"none"`). When
 * Venice does NOT list "none", we leave "off" UNSET (undefined): pi still offers
 * "off" in the thinking selector, but no `reasoning_effort` is sent (sending an
 * unsupported value makes Venice reject the request), and the before_provider_request
 * handler disables thinking via `venice_parameters.disable_thinking` instead.
 */
function buildThinkingLevelMap(options: string[]): ThinkingLevelMap {
	const supported = new Set(options);
	const map: ThinkingLevelMap = {};
	for (const level of PI_LEVELS) {
		if (level === "off") {
			if (supported.has("none")) map.off = "none";
			continue;
		}
		map[level] = supported.has(level) ? level : null;
	}
	return map;
}

// ---- Venice /models response shape (only the fields we use) ----

interface VenicePrice {
	usd?: number;
}

interface VeniceExtendedPricing {
	context_token_threshold?: number;
	input?: VenicePrice;
	cache_input?: VenicePrice;
	cache_write?: VenicePrice;
	output?: VenicePrice;
}

interface VenicePricing {
	input?: VenicePrice;
	cache_input?: VenicePrice;
	cache_write?: VenicePrice;
	output?: VenicePrice;
	extended?: VeniceExtendedPricing;
}

interface VeniceCapabilities {
	supportsReasoning?: boolean;
	supportsReasoningEffort?: boolean;
	reasoningEffortOptions?: string[];
	supportsVision?: boolean;
	supportsMultipleImages?: boolean;
	supportsFunctionCalling?: boolean;
	supportsE2EE?: boolean;
	supportsWebSearch?: boolean;
	supportsXSearch?: boolean;
	supportsResponseSchema?: boolean;
	supportsLogProbs?: boolean;
	supportsAudioInput?: boolean;
	supportsVideoInput?: boolean;
	supportsTeeAttestation?: boolean;
	optimizedForCode?: boolean;
	quantization?: string;
}

interface VeniceModelSpec {
	name?: string;
	description?: string;
	pricing?: VenicePricing;
	availableContextTokens?: number;
	maxCompletionTokens?: number;
	capabilities?: VeniceCapabilities;
	offline?: boolean;
	beta?: boolean;
}

interface VeniceModel {
	id: string;
	context_length?: number;
	object: string;
	type: string; // "text" | "image" | "audio" | "video" | ...
	model_spec?: VeniceModelSpec;
}

interface ModelCaps {
	reasoning: boolean;
	/** True when "off" can be expressed via reasoning_effort:"none" (Venice lists it). */
	hasNone: boolean;
}

interface DiscoveredCatalog {
	models: Model<Api>[];
	capabilities: Map<string, ModelCaps>;
}

/** Fetch Venice's public model catalog and map every text model to a pi Model. */
async function fetchVeniceJson<T>(url: string, endpoint: string, signal: AbortSignal): Promise<T> {
	const res = await fetch(url, { headers: { Accept: "application/json" }, signal });
	if (!res.ok) {
		throw new Error(`Venice ${endpoint} returned HTTP ${res.status} ${res.statusText}`);
	}
	return (await res.json()) as T;
}

/** Fetch Venice's text catalog and stable trait aliases, then map them to pi models. */
async function discoverVeniceModels(signal?: AbortSignal): Promise<DiscoveredCatalog> {
	const requestSignal = signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
	const [modelsBody, traitsResult]: [
		{ data?: VeniceModel[] },
		{ data?: Record<string, string> },
	] = await Promise.all([
		fetchVeniceJson<{ data?: VeniceModel[] }>(VENICE_MODELS_URL, "/models", requestSignal),
		fetchVeniceJson<{ data?: Record<string, string> }>(VENICE_MODEL_TRAITS_URL, "/models/traits", requestSignal).catch(
			(error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				console.warn(`[venice] trait discovery failed: ${message}. Concrete model IDs remain available.`);
				return { data: {} };
			},
		),
	]);
	const data = modelsBody.data ?? [];

	const models: Model<Api>[] = [];
	const capabilities = new Map<string, ModelCaps>();
	const modelsById = new Map<string, Model<Api>>();

	for (const m of data) {
		// Only chat-completion ("text") models are usable through this provider.
		if (m.type !== "text") continue;
		const spec = m.model_spec;
		if (!spec) continue;
		// Skip models Venice marks unavailable or restricted to beta users. The
		// public discovery request cannot know whether the eventual key has beta access.
		if (spec.offline || spec.beta) continue;
		const caps = spec.capabilities;
		if (!caps) continue;
		// E2EE models require a client-side handshake and encrypted transport that
		// pi's OpenAI-compatible adapter does not implement. Advertising them here
		// would create selectable models that cannot complete a request safely.
		if (caps.supportsE2EE) continue;
		// pi is a tool-using coding agent. Models without function calling cannot
		// participate in its agent loop, so do not advertise them as usable here.
		if (!caps.supportsFunctionCalling) continue;

		const reasoning = !!caps.supportsReasoning;
		const effort = !!(caps.supportsReasoningEffort && caps.reasoningEffortOptions?.length);
		const effortOptions = caps.reasoningEffortOptions ?? [];
		const hasNone = effort && effortOptions.includes("none");
		const contextWindow = spec.availableContextTokens ?? m.context_length ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens = spec.maxCompletionTokens ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS);
		const pricing = spec.pricing ?? {};
		const baseCost = {
			input: pricing.input?.usd ?? 0,
			output: pricing.output?.usd ?? 0,
			cacheRead: pricing.cache_input?.usd ?? 0,
			cacheWrite: pricing.cache_write?.usd ?? 0,
		};
		const extended = pricing.extended;
		const tiers =
			extended?.context_token_threshold === undefined
				? undefined
				: [
						{
							inputTokensAbove: extended.context_token_threshold,
							input: extended.input?.usd ?? baseCost.input,
							output: extended.output?.usd ?? baseCost.output,
							cacheRead: extended.cache_input?.usd ?? baseCost.cacheRead,
							cacheWrite: extended.cache_write?.usd ?? baseCost.cacheWrite,
						},
					];
		const hasCacheSupport = !!(pricing.cache_input || pricing.cache_write);
		const input: ("text" | "image")[] = caps.supportsVision ? ["text", "image"] : ["text"];

		const model = {
			id: m.id,
			name: spec.name ?? m.id,
			api: "openai-completions" as const,
			provider: PROVIDER_ID,
			baseUrl: VENICE_BASE_URL,
			reasoning,
			input,
			cost: { ...baseCost, ...(tiers ? { tiers } : {}) },
			contextWindow,
			maxTokens,
			...(effort ? { thinkingLevelMap: buildThinkingLevelMap(effortOptions) } : {}),
			compat: {
				// Venice accepts both system and developer messages.
				supportsDeveloperRole: true,
				// Send reasoning_effort (OpenAI-compatible) only when the model
				// actually exposes effort controls.
				supportsReasoningEffort: effort,
				// Venice prefers max_completion_tokens over the deprecated max_tokens.
				maxTokensField: "max_completion_tokens" as const,
				// Venice accepts Anthropic-style cache_control markers on content parts.
				...(hasCacheSupport ? { cacheControlFormat: "anthropic" as const } : {}),
				// Venice supports prompt_cache_retention: "24h" for cache-capable models.
				...(hasCacheSupport ? { supportsLongCacheRetention: true } : {}),
			},
		} as unknown as Model<Api>;

		models.push(model);
		modelsById.set(m.id, model);
		capabilities.set(m.id, { reasoning, hasNone });
	}

	// Traits are stable Venice-owned selectors. Register them as model aliases so
	// users can choose venice/default_code (etc.) instead of pinning a rotating ID.
	for (const [trait, targetId] of Object.entries(traitsResult.data ?? {})) {
		const target = modelsById.get(targetId);
		const targetCaps = capabilities.get(targetId);
		if (!target || !targetCaps || modelsById.has(trait)) continue;
		const alias = {
			...target,
			id: trait,
			name: `${trait.replaceAll("_", " ")} (trait → ${target.name})`,
		} as Model<Api>;
		models.push(alias);
		modelsById.set(trait, alias);
		capabilities.set(trait, targetCaps);
	}

	models.sort((a, b) => a.name.localeCompare(b.name));
	return { models, capabilities };
}

export default async function (pi: ExtensionAPI): Promise<void> {
	let catalog: DiscoveredCatalog = { models: [], capabilities: new Map() };
	try {
		catalog = await discoverVeniceModels();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(
			`[venice] model discovery failed: ${message}. ` +
				`The provider is still available via \`/login venice\`; run /reload to retry discovery.`,
		);
	}

	pi.registerProvider(
		createProvider({
			id: PROVIDER_ID,
			name: "Venice",
			baseUrl: VENICE_BASE_URL,
			// envApiKeyAuth gives `/login venice` (prompts + stores the key) AND
			// a $VENICE_API_KEY env-var fallback. The resolved key is sent as
			// `Authorization: Bearer <key>` by the openai-completions API.
			auth: { apiKey: envApiKeyAuth("Venice API key", ["VENICE_API_KEY"]) },
			api: openAICompletionsApi(),
			models: catalog.models,
		}),
	);

	// Inject Venice-specific request parameters. Scoped to the venice provider so
	// unrelated providers are untouched. Runs per request; returning a new
	// payload replaces the outgoing body.
	pi.on("before_provider_request", ((event: { payload: unknown }, ctx: { model?: { provider?: string; id?: string }; thinkingLevel?: string }) => {
		const model = ctx.model;
		if (model?.provider !== PROVIDER_ID) return;
		const payload = event.payload as Record<string, unknown> | null;
		if (!payload || typeof payload !== "object") return;

		const veniceParameters: Record<string, unknown> = {
			...(payload.venice_parameters ?? {}),
			// Make pi's system prompt the sole system prompt instead of appending
			// Venice's defaults. Essential for a coding agent's curated prompt.
			include_venice_system_prompt: false,
		};

		// Disable thinking for reasoning models that can't express "off" via
		// reasoning_effort:"none" (effort-controlled models that don't list "none",
		// and reasoning models without effort control). Models that DO list "none"
		// already send reasoning_effort:"none" for the "off" level via thinkingLevelMap.
		const caps = model.id ? catalog.capabilities.get(model.id) : undefined;
		if (caps?.reasoning && !caps.hasNone && ctx.thinkingLevel === "off") {
			veniceParameters.disable_thinking = true;
		}

		// pi adds Anthropic-style cache_control to the LAST tool definition when
		// a model advertises cache pricing (cacheControlFormat: "anthropic").
		// Venice's chat schema rejects cache_control on tools entirely
		// (400: Extra inputs are not permitted, field: 'tools[N].cache_control')
		// — seen with kimi-k3 — so strip it from every tool. Message-level
		// cache_control is left intact; Venice documents support for it there.
		const tools = payload.tools;
		let strippedTools = tools;
		if (Array.isArray(tools)) {
			strippedTools = tools.map((tool: unknown) => {
				if (tool && typeof tool === "object" && "cache_control" in tool) {
					const { cache_control: _dropped, ...rest } = tool as Record<string, unknown>;
					return rest;
				}
				return tool;
			});
		}

		return { ...payload, tools: strippedTools, venice_parameters: veniceParameters };
	}) as never);
}
