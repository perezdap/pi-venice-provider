/**
 * Venice.ai provider extension for pi.
 *
 * Registers the "venice" provider against Venice's OpenAI-compatible Chat
 * Completions API (https://api.venice.ai/api/v1). The full model catalog —
 * including per-model context windows, max output tokens, pricing, and
 * capabilities — is discovered at startup from Venice's public /models
 * endpoint, so context windows are always correct for each model.
 *
 * Auth: `/login venice` prompts for a Venice API key and stores it, with
 * $VENICE_API_KEY used as an automatic fallback. Chat requests are sent
 * exactly as Venice expects:
 *
 *   - `Authorization: Bearer <key>` (resolved by openai-completions + envApiKeyAuth)
 *   - `system` role (compat.supportsDeveloperRole = false) so Venice's
 *     system-prompt handling applies to our prompt
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
 *   - Streamed `reasoning_content` deltas are parsed into thinking blocks by
 *     pi's built-in openai-completions API (no custom streaming needed)
 *
 * Usage:
 *   /login venice        # enter your Venice API key (or export VENICE_API_KEY)
 *   /model venice/<id>   # pick a model, e.g. venice/zai-org-glm-5-1
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
const VENICE_MODELS_URL = "https://api.venice.ai/api/v1/models";

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

interface VenicePricing {
	input?: { usd?: number };
	cache_input?: { usd?: number };
	output?: { usd?: number };
}

interface VeniceCapabilities {
	supportsReasoning?: boolean;
	supportsReasoningEffort?: boolean;
	reasoningEffortOptions?: string[];
	supportsVision?: boolean;
	supportsMultipleImages?: boolean;
	supportsFunctionCalling?: boolean;
}

interface VeniceModelSpec {
	name?: string;
	description?: string;
	pricing?: VenicePricing;
	availableContextTokens?: number;
	maxCompletionTokens?: number;
	capabilities?: VeniceCapabilities;
	offline?: boolean;
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
async function discoverVeniceModels(signal?: AbortSignal): Promise<DiscoveredCatalog> {
	const res = await fetch(VENICE_MODELS_URL, {
		headers: { Accept: "application/json" },
		signal: signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`Venice /models returned HTTP ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as { data?: VeniceModel[] };
	const data = body.data ?? [];

	const models: Model<Api>[] = [];
	const capabilities = new Map<string, ModelCaps>();

	for (const m of data) {
		// Only chat-completion ("text") models are usable through this provider.
		if (m.type !== "text") continue;
		const spec = m.model_spec;
		if (!spec) continue;
		// Skip models Venice marks unavailable.
		if (spec.offline) continue;
		const caps = spec.capabilities;
		if (!caps) continue;

		const reasoning = !!caps.supportsReasoning;
		const effort = !!(caps.supportsReasoningEffort && caps.reasoningEffortOptions?.length);
		const effortOptions = caps.reasoningEffortOptions ?? [];
		const hasNone = effort && effortOptions.includes("none");
		const contextWindow = spec.availableContextTokens ?? m.context_length ?? DEFAULT_CONTEXT_WINDOW;
		const maxTokens = spec.maxCompletionTokens ?? Math.min(contextWindow, DEFAULT_MAX_TOKENS);
		const pricing = spec.pricing ?? {};
		const input: ("text" | "image")[] = caps.supportsVision ? ["text", "image"] : ["text"];

		const model = {
			id: m.id,
			name: spec.name ?? m.id,
			api: "openai-completions" as const,
			provider: PROVIDER_ID,
			baseUrl: VENICE_BASE_URL,
			reasoning,
			input,
			cost: {
				input: pricing.input?.usd ?? 0,
				output: pricing.output?.usd ?? 0,
				// Venice charges cached prompt reads at cache_input. The openai-completions
				// API maps prompt_tokens_details.cached_tokens -> cacheRead usage, so this
				// rate is applied to cached tokens. Venice reports no cache-write tokens.
				cacheRead: pricing.cache_input?.usd ?? 0,
				cacheWrite: 0,
			},
			contextWindow,
			maxTokens,
			...(effort ? { thinkingLevelMap: buildThinkingLevelMap(effortOptions) } : {}),
			compat: {
				// Force the "system" role so Venice's system-prompt handling and our
				// include_venice_system_prompt:false override apply to pi's prompt.
				supportsDeveloperRole: false,
				// Send reasoning_effort (OpenAI-compatible) only when the model
				// actually exposes effort controls.
				supportsReasoningEffort: effort,
				// Venice prefers max_completion_tokens over the deprecated max_tokens.
				maxTokensField: "max_completion_tokens" as const,
			},
		} as unknown as Model<Api>;

		models.push(model);
		capabilities.set(m.id, { reasoning, hasNone });
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

		return { ...payload, venice_parameters: veniceParameters };
	}) as never);
}
