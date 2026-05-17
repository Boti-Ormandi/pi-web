import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DEFAULTS, TIER_NAMES } from "./defaults.js";
import type {
	Config,
	ConfigSource,
	CostDisplay,
	PartialConfig,
	ResolvedConfig,
	TierConfig,
	TierName,
} from "./schema.js";

export interface LoadOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	globalConfigPath?: string;
	projectConfigPath?: string;
	cliFlags?: CliFlagOverlay;
}

export interface CliFlagOverlay {
	noCache?: boolean;
	summaryModel?: string;
	debug?: boolean;
}

const TIER_VALUES: readonly TierName[] = TIER_NAMES;
const COST_DISPLAY_VALUES: readonly CostDisplay[] = ["always", "debug", "never"];

function readJsonFile(path: string): unknown {
	const raw = readFileSync(path, "utf8");
	return JSON.parse(raw);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: unknown): T {
	if (!isPlainObject(patch)) return base;
	if (!isPlainObject(base)) return patch as T;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) continue;
		const current = out[key];
		if (isPlainObject(current) && isPlainObject(value)) {
			out[key] = deepMerge(current, value);
		} else {
			out[key] = value;
		}
	}
	return out as T;
}

function isTierName(value: unknown): value is TierName {
	return typeof value === "string" && (TIER_VALUES as readonly string[]).includes(value);
}

function isCostDisplay(value: unknown): value is CostDisplay {
	return typeof value === "string" && (COST_DISPLAY_VALUES as readonly string[]).includes(value);
}

function isTierConfig(value: unknown): value is TierConfig {
	if (typeof value === "string") return true;
	if (!isPlainObject(value)) return false;
	const auto = value.auto;
	return auto === "latest-haiku" || auto === "latest-sonnet" || auto === "latest-opus";
}

function validatePartial(value: unknown): PartialConfig {
	if (!isPlainObject(value)) return {};
	const out: PartialConfig = {};

	const models = value.models;
	if (isPlainObject(models)) {
		const m: NonNullable<PartialConfig["models"]> = {};
		if (isPlainObject(models.tiers)) {
			const tiers: Partial<Record<TierName, TierConfig>> = {};
			for (const tier of TIER_VALUES) {
				const t = (models.tiers as Record<string, unknown>)[tier];
				if (isTierConfig(t)) tiers[tier] = t;
			}
			if (Object.keys(tiers).length > 0) m.tiers = tiers as Record<TierName, TierConfig>;
		}
		if (Array.isArray(models.allowed_models)) {
			m.allowed_models = models.allowed_models.filter((s): s is string => typeof s === "string");
		}
		if (typeof models.allow_unregistered === "boolean") {
			m.allow_unregistered = models.allow_unregistered;
		}
		if (Object.keys(m).length > 0) out.models = m;
	}

	const search = value.search;
	if (isPlainObject(search)) {
		const s: NonNullable<PartialConfig["search"]> = {};
		if (isTierName(search.tier)) s.tier = search.tier;
		if (typeof search.include_synthesis === "boolean") s.include_synthesis = search.include_synthesis;
		if (typeof search.default_max_results === "number") {
			s.default_max_results = Math.max(1, Math.min(10, Math.trunc(search.default_max_results)));
		}
		if (Array.isArray(search.global_allowed_domains)) {
			s.global_allowed_domains = search.global_allowed_domains.filter(
				(d): d is string => typeof d === "string",
			);
		}
		if (Array.isArray(search.global_blocked_domains)) {
			s.global_blocked_domains = search.global_blocked_domains.filter(
				(d): d is string => typeof d === "string",
			);
		}
		if (Object.keys(s).length > 0) out.search = s;
	}

	const fetchCfg = value.fetch;
	if (isPlainObject(fetchCfg)) {
		const f: NonNullable<PartialConfig["fetch"]> = {};
		if (isTierName(fetchCfg.summary_tier)) f.summary_tier = fetchCfg.summary_tier;
		if (fetchCfg.thinking_budget === null) f.thinking_budget = null;
		else if (typeof fetchCfg.thinking_budget === "number") f.thinking_budget = fetchCfg.thinking_budget;
		if (typeof fetchCfg.answer_max_tokens === "number") f.answer_max_tokens = fetchCfg.answer_max_tokens;
		if (typeof fetchCfg.raw_max_bytes === "number") f.raw_max_bytes = fetchCfg.raw_max_bytes;
		if (typeof fetchCfg.request_timeout_ms === "number") f.request_timeout_ms = fetchCfg.request_timeout_ms;
		if (typeof fetchCfg.max_response_bytes === "number") f.max_response_bytes = fetchCfg.max_response_bytes;
		if (typeof fetchCfg.follow_redirects === "boolean") f.follow_redirects = fetchCfg.follow_redirects;
		if (typeof fetchCfg.max_redirects === "number") f.max_redirects = fetchCfg.max_redirects;
		if (typeof fetchCfg.user_agent_contact === "string") f.user_agent_contact = fetchCfg.user_agent_contact;
		if (Object.keys(f).length > 0) out.fetch = f;
	}

	const cache = value.cache;
	if (isPlainObject(cache)) {
		const c: NonNullable<PartialConfig["cache"]> = {};
		if (typeof cache.enabled === "boolean") c.enabled = cache.enabled;
		if (typeof cache.ttl_seconds === "number") c.ttl_seconds = cache.ttl_seconds;
		if (typeof cache.max_entries === "number") c.max_entries = cache.max_entries;
		if (typeof cache.persist_to_disk === "boolean") c.persist_to_disk = cache.persist_to_disk;
		if (Object.keys(c).length > 0) out.cache = c;
	}

	const security = value.security;
	if (isPlainObject(security)) {
		const s: NonNullable<PartialConfig["security"]> = {};
		if (typeof security.allow_private_ips === "boolean") s.allow_private_ips = security.allow_private_ips;
		if (typeof security.allow_file_urls === "boolean") s.allow_file_urls = security.allow_file_urls;
		if (Object.keys(s).length > 0) out.security = s;
	}

	const display = value.display;
	if (isPlainObject(display)) {
		const d: NonNullable<PartialConfig["display"]> = {};
		if (isCostDisplay(display.show_cost)) d.show_cost = display.show_cost;
		if (Object.keys(d).length > 0) out.display = d;
	}

	return out;
}

function envOverrides(env: NodeJS.ProcessEnv): PartialConfig {
	const out: PartialConfig = {};
	const search: NonNullable<PartialConfig["search"]> = {};
	const fetchCfg: NonNullable<PartialConfig["fetch"]> = {};
	const cache: NonNullable<PartialConfig["cache"]> = {};
	const models: NonNullable<PartialConfig["models"]> = {};

	const searchTier = env.PI_WEB_SEARCH_TIER;
	if (isTierName(searchTier)) search.tier = searchTier;

	const fetchTier = env.PI_WEB_FETCH_TIER;
	if (isTierName(fetchTier)) fetchCfg.summary_tier = fetchTier;

	const summaryModel = env.PI_WEB_SUMMARY_MODEL;
	if (typeof summaryModel === "string" && summaryModel.length > 0) {
		// Pin balanced tier to the requested model id.
		models.tiers = {
			...(models.tiers ?? {}),
			balanced: summaryModel,
		} as Record<TierName, TierConfig>;
	}

	const thinking = env.PI_WEB_THINKING_BUDGET;
	if (typeof thinking === "string" && thinking.length > 0) {
		const n = Number(thinking);
		if (Number.isFinite(n)) fetchCfg.thinking_budget = n;
	}

	const ttl = env.PI_WEB_CACHE_TTL;
	if (typeof ttl === "string" && ttl.length > 0) {
		const n = Number(ttl);
		if (Number.isFinite(n)) cache.ttl_seconds = n;
	}

	const contact = env.PI_WEB_USER_AGENT_CONTACT;
	if (typeof contact === "string" && contact.length > 0) {
		fetchCfg.user_agent_contact = contact;
	}

	if (env.PI_WEB_DISABLE_CACHE === "1" || env.PI_WEB_DISABLE_CACHE === "true") {
		cache.enabled = false;
	}

	if (Object.keys(search).length > 0) out.search = search;
	if (Object.keys(fetchCfg).length > 0) out.fetch = fetchCfg;
	if (Object.keys(cache).length > 0) out.cache = cache;
	if (Object.keys(models).length > 0) out.models = models;

	return out;
}

function flagOverrides(flags: CliFlagOverlay): PartialConfig {
	const out: PartialConfig = {};
	if (flags.noCache) {
		out.cache = { enabled: false };
	}
	if (flags.summaryModel && flags.summaryModel.length > 0) {
		const models = (out.models ?? {}) as NonNullable<PartialConfig["models"]>;
		models.tiers = {
			...(models.tiers ?? {}),
			balanced: flags.summaryModel,
		} as Record<TierName, TierConfig>;
		out.models = models;
	}
	return out;
}

export function defaultGlobalConfigPath(): string {
	return resolve(homedir(), ".pi", "agent", "extensions", "pi-web", "config.json");
}

export function defaultProjectConfigPath(cwd: string): string {
	return resolve(cwd, ".pi", "pi-web.json");
}

export function loadConfig(opts: LoadOptions): ResolvedConfig {
	const env = opts.env ?? process.env;
	const globalPath = opts.globalConfigPath ?? defaultGlobalConfigPath();
	const projectPath = opts.projectConfigPath ?? defaultProjectConfigPath(opts.cwd);

	const sources: ConfigSource[] = [{ label: "defaults", value: {} }];
	let config: Config = DEFAULTS;

	const tryLayer = (label: string, path: string) => {
		if (!existsSync(path)) return;
		try {
			const raw = readJsonFile(path);
			const validated = validatePartial(raw);
			sources.push({ label, path, value: validated });
			config = deepMerge(config, validated);
		} catch (err) {
			sources.push({
				label: `${label} (error)`,
				path,
				value: { _error: err instanceof Error ? err.message : String(err) } as unknown as PartialConfig,
			});
		}
	};

	tryLayer("global", globalPath);
	tryLayer("project", projectPath);

	const envPatch = envOverrides(env);
	if (Object.keys(envPatch).length > 0) {
		sources.push({ label: "env", value: envPatch });
		config = deepMerge(config, envPatch);
	}

	if (opts.cliFlags) {
		const flagPatch = flagOverrides(opts.cliFlags);
		if (Object.keys(flagPatch).length > 0) {
			sources.push({ label: "cli", value: flagPatch });
			config = deepMerge(config, flagPatch);
		}
	}

	return { config, sources };
}

export { deepMerge };
