// Integration test: loads the real extension, runs the async factory (which
// fetches Venice's live /models catalog), and asserts the model mapping and
// the before_provider_request hook behave correctly.
//
// Run:  node test/venice.test.mjs   (from the venice/ dir, with the junctions
// in ../node_modules/@earendil-works created by the install step)

let pass = 0;
let fail = 0;
function assert(cond, msg) {
	if (cond) pass++;
	else {
		fail++;
		console.error("  FAIL:", msg);
	}
}
function assertEq(actual, expected, msg) {
	const ok = actual === expected;
	if (ok) pass++;
	else {
		fail++;
		console.error(`  FAIL: ${msg}\n        expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`);
	}
}

const mod = await import("../index.ts");
const factory = mod.default;
assert(typeof factory === "function", "default export is a function");

const registered = [];
const handlers = {};
const pi = {
	registerProvider(provider) {
		registered.push(provider);
	},
	on(event, handler) {
		(handlers[event] ??= []).push(handler);
	},
};

await factory(pi);

assertEq(registered.length, 1, "exactly one provider registered");
const provider = registered[0];
assertEq(provider.id, "venice", "provider id is 'venice'");
assertEq(provider.name, "Venice", "provider name is 'Venice'");
assertEq(provider.baseUrl, "https://api.venice.ai/api/v1", "provider baseUrl");
assert(!!provider.auth?.apiKey, "provider has apiKey auth (for /login)");
assert(typeof provider.auth.apiKey.login === "function", "auth has login() for /login");
assert(typeof provider.auth.apiKey.resolve === "function", "auth has resolve()");
assert(typeof provider.streamSimple === "function", "provider exposes streamSimple (openai-completions)");

const models = provider.getModels();
assert(models.length > 0, `discovered models (count=${models.length})`);
const liveCatalog = await fetch("https://api.venice.ai/api/v1/models?type=text").then((response) => response.json());
const liveById = new Map(liveCatalog.data.map((model) => [model.id, model]));
assert(!models.some((m) => m.id.startsWith("e2ee-")), "E2EE-only models are omitted (transport handshake unsupported)");

// Every mapped model must have the required fields and our compat overrides.
for (const m of models) {
	assertEq(m.provider, "venice", `model ${m.id}: provider`);
	assertEq(m.api, "openai-completions", `model ${m.id}: api`);
	assertEq(m.baseUrl, "https://api.venice.ai/api/v1", `model ${m.id}: baseUrl`);
	assert(m.contextWindow > 0, `model ${m.id}: contextWindow > 0`);
	assert(m.maxTokens > 0, `model ${m.id}: maxTokens > 0`);
	assert(m.maxTokens <= m.contextWindow, `model ${m.id}: maxTokens <= contextWindow`);
	assert(typeof m.cost.input === "number", `model ${m.id}: cost.input is number`);
	assert(typeof m.cost.output === "number", `model ${m.id}: cost.output is number`);
	assert(typeof m.cost.cacheRead === "number", `model ${m.id}: cost.cacheRead is number`);
	assert(typeof m.cost.cacheWrite === "number", `model ${m.id}: cost.cacheWrite is number`);
	for (const tier of m.cost.tiers ?? []) {
		assert(tier.inputTokensAbove > 0, `model ${m.id}: tier threshold > 0`);
		assert(typeof tier.cacheWrite === "number", `model ${m.id}: tier cacheWrite is number`);
	}
	assert(Array.isArray(m.input) && m.input.includes("text"), `model ${m.id}: input includes text`);
	const live = liveById.get(m.id);
	if (live) {
		assertEq(live.model_spec.capabilities.supportsFunctionCalling, true, `model ${m.id}: supports function calling`);
		assertEq(live.model_spec.capabilities.supportsE2EE, false, `model ${m.id}: does not require E2EE transport`);
	}
	assertEq(m.compat?.supportsDeveloperRole, true, `model ${m.id}: supportsDeveloperRole=true`);
	assertEq(m.compat?.maxTokensField, "max_completion_tokens", `model ${m.id}: maxTokensField`);
	// "off" must always remain selectable for reasoning models (never null).
	if (m.reasoning) {
		assert(m.thinkingLevelMap?.off !== null, `model ${m.id}: off is selectable (not null)`);
	}
}

const traitModels = models.filter((m) => ["default", "default_reasoning", "default_code", "default_vision", "function_calling_default", "most_intelligent", "most_uncensored"].includes(m.id));
assert(traitModels.length > 0, "discovered stable trait aliases from /models/traits");
for (const m of traitModels) {
	assert(m.name.includes("trait →"), `trait ${m.id}: display name identifies resolved target`);
}

const cacheWriteModels = models.filter((m) => m.cost.cacheWrite > 0);
assert(cacheWriteModels.length > 0, "at least one model exposes cache-write pricing");
for (const m of cacheWriteModels) {
	assertEq(m.compat.cacheControlFormat, "anthropic", `model ${m.id}: cache-control format`);
}
assert(models.some((m) => (m.cost.tiers?.length ?? 0) > 0), "at least one model exposes long-context pricing tiers");

const effortModels = models.filter((m) => m.reasoning && m.compat.supportsReasoningEffort);
assert(effortModels.length > 0, "at least one effort-controlled reasoning model exists");
for (const m of effortModels) {
	const map = m.thinkingLevelMap;
	assert(!!map, `model ${m.id}: has thinkingLevelMap`);
	// off is "none" (when Venice offers it) or undefined (when it doesn't); never null.
	assert(map.off === "none" || map.off === undefined, `model ${m.id}: off is "none" or undefined (got ${map.off})`);
	for (const lvl of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
		const v = map[lvl];
		if (v !== null && v !== undefined) assert(typeof v === "string", `model ${m.id}: ${lvl} maps to string`);
	}
}

// Reasoning models WITHOUT effort control: no thinkingLevelMap, effort flag off.
const noEffortReasoning = models.filter((m) => m.reasoning && !m.compat.supportsReasoningEffort);
for (const m of noEffortReasoning) {
	assert(m.thinkingLevelMap === undefined, `model ${m.id}: no thinkingLevelMap (effort unsupported)`);
}

// Vision models advertise image input.
for (const m of models.filter((mm) => mm.input.includes("image"))) {
	assert(m.input.includes("image"), `model ${m.id}: vision -> image input`);
}

// Known-model sanity (if present in the live catalog).
const glm51 = models.find((m) => m.id === "zai-org-glm-5-1");
if (glm51) {
	assertEq(glm51.contextWindow, 200000, "glm-5-1 contextWindow = 200000");
	assertEq(glm51.maxTokens, 80000, "glm-5-1 maxTokens = 80000");
	assertEq(glm51.reasoning, true, "glm-5-1 reasoning = true");
	assertEq(glm51.compat.supportsReasoningEffort, true, "glm-5-1 supportsReasoningEffort");
	assertEq(glm51.thinkingLevelMap.off, "none", "glm-5-1 off -> none (Venice lists none)");
	assertEq(glm51.thinkingLevelMap.high, "high", "glm-5-1 high -> high");
	assertEq(glm51.thinkingLevelMap.max, null, "glm-5-1 max -> null (unsupported)");
	assertEq(glm51.input.includes("image"), false, "glm-5-1 is text-only");
	assert(glm51.cost.input > 0, "glm-5-1 cost.input > 0");
}
const g35 = models.find((m) => m.id === "gemini-3-5-flash");
if (g35) {
	assertEq(g35.compat.supportsReasoningEffort, true, "gemini-3-5-flash supportsReasoningEffort");
	// Venice does NOT list "none" for this model -> off is omitted (undefined), not "none".
	assertEq(g35.thinkingLevelMap.off, undefined, "gemini-3-5-flash off omitted (no none offered)");
	assertEq(g35.thinkingLevelMap.high, "high", "gemini-3-5-flash high -> high");
}
const g36 = models.find((m) => m.id === "gemini-3-6-flash");
if (g36) {
	assertEq(g36.compat.supportsReasoningEffort, false, "gemini-3-6-flash effort unsupported");
	assertEq(g36.reasoning, true, "gemini-3-6-flash is reasoning");
	assert(g36.thinkingLevelMap === undefined, "gemini-3-6-flash no thinkingLevelMap");
}

// ---- before_provider_request hook ----
const hookHandlers = handlers.before_provider_request ?? [];
assertEq(hookHandlers.length, 1, "one before_provider_request handler registered");
const hook = hookHandlers[0];
function runHook(model, thinkingLevel, payload) {
	return hook({ type: "before_provider_request", payload }, { model, thinkingLevel });
}

// Non-venice provider: untouched.
assertEq(runHook({ provider: "openai", id: "gpt-4" }, "medium", { model: "x", messages: [] }), undefined, "non-venice provider untouched");

// Venice model: include_venice_system_prompt=false, existing fields preserved.
if (effortModels.length > 0) {
	const m = effortModels[0];
	const out = runHook({ provider: "venice", id: m.id }, "high", { model: m.id, messages: [], reasoning_effort: "high" });
	assert(!!out, "venice request returns a payload");
	assertEq(out.venice_parameters?.include_venice_system_prompt, false, "include_venice_system_prompt=false");
	assertEq(out.model, m.id, "payload fields preserved");
	assertEq(out.reasoning_effort, "high", "existing payload fields preserved");
}

// Has-"none" model @ off: reasoning_effort:"none" is the mechanism; no disable_thinking.
if (glm51) {
	const out = runHook({ provider: "venice", id: "zai-org-glm-5-1" }, "off", { model: "zai-org-glm-5-1", messages: [] });
	assertEq(out.venice_parameters?.disable_thinking, undefined, "glm-5-1 @ off: no disable_thinking (uses reasoning_effort:none)");
}

// No-"none" effort model @ off: disable_thinking=true.
if (g35) {
	const out = runHook({ provider: "venice", id: "gemini-3-5-flash" }, "off", { model: "gemini-3-5-flash", messages: [] });
	assertEq(out.venice_parameters?.disable_thinking, true, "gemini-3-5-flash @ off: disable_thinking=true");
	const out2 = runHook({ provider: "venice", id: "gemini-3-5-flash" }, "high", { model: "gemini-3-5-flash", messages: [] });
	assertEq(out2.venice_parameters?.disable_thinking, undefined, "gemini-3-5-flash @ high: no disable_thinking");
}

// Effort-unsupported reasoning model @ off: disable_thinking=true.
if (g36) {
	const out = runHook({ provider: "venice", id: "gemini-3-6-flash" }, "off", { model: "gemini-3-6-flash", messages: [] });
	assertEq(out.venice_parameters?.disable_thinking, true, "gemini-3-6-flash @ off: disable_thinking=true");
	const out2 = runHook({ provider: "venice", id: "gemini-3-6-flash" }, "medium", { model: "gemini-3-6-flash", messages: [] });
	assertEq(out2.venice_parameters?.disable_thinking, undefined, "gemini-3-6-flash @ medium: no disable_thinking");
}

// Non-reasoning model @ off: no disable_thinking, still gets system-prompt override.
const nonReasoning = models.find((m) => !m.reasoning);
if (nonReasoning) {
	const out = runHook({ provider: "venice", id: nonReasoning.id }, "off", { model: nonReasoning.id, messages: [] });
	assertEq(out.venice_parameters?.disable_thinking, undefined, "non-reasoning @ off: no disable_thinking");
	assertEq(out.venice_parameters?.include_venice_system_prompt, false, "non-reasoning: system-prompt override still applied");
}

// ---- auth: /login flow + env fallback + stored credential ----
const auth = provider.auth.apiKey;
const mockInteraction = {
	signal: { throwIfAborted() {} },
	prompt: async () => "test-key-from-login",
};
const loginResult = await auth.login(mockInteraction);
assertEq(loginResult.type, "api_key", "login() returns an api_key credential");
assertEq(loginResult.key, "test-key-from-login", "login() returns the prompted key");

const resolveCtx = {
	env: async (name) => (name === "VENICE_API_KEY" ? process.env.VENICE_API_KEY : undefined),
};
// Stored credential wins.
const stored = await auth.resolve({ ctx: resolveCtx, credential: { type: "api_key", key: "stored-key" }, signal: { throwIfAborted() {} } });
assertEq(stored.auth.apiKey, "stored-key", "resolve(): stored credential wins");
assertEq(stored.source, "stored credential", "resolve(): source is 'stored credential'");
// Env fallback when no stored credential.
if (process.env.VENICE_API_KEY) {
	const envd = await auth.resolve({ ctx: resolveCtx, credential: undefined, signal: { throwIfAborted() {} } });
	assertEq(envd.auth.apiKey, process.env.VENICE_API_KEY, "resolve(): falls back to VENICE_API_KEY env");
	assertEq(envd.source, "VENICE_API_KEY", "resolve(): source is the env var name");
}
// Nothing configured -> undefined.
const noneCtx = { env: async () => undefined };
const none = await auth.resolve({ ctx: noneCtx, credential: undefined, signal: { throwIfAborted() {} } });
assertEq(none, undefined, "resolve(): undefined when nothing configured");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
