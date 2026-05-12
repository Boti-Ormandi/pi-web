import type { Config, TierName } from "./schema.js";

// Position-0 system segment required by Anthropic's OAuth auth-layer gate.
// Any other text in this slot causes a synthetic 429 with no rate-limit
// headers. Do not change the wording.
export const PREAMBLE = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export const ANTHROPIC_BETA_HEADER = "oauth-2025-04-20";

export const ANTHROPIC_VERSION_HEADER = "2023-06-01";

export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";

export const WEB_FETCH_TOOL_TYPE = "web_fetch_20250910";

export const SERVER_FETCH_DEFAULT_MAX_CONTENT_TOKENS = 100_000;

export const TIER_NAMES: readonly TierName[] = ["fast", "balanced", "strong"] as const;

export const TIER_FAMILY_PATTERNS: Record<TierName, RegExp> = {
	fast: /haiku/i,
	balanced: /sonnet/i,
	strong: /opus/i,
};

export const DEFAULTS: Config = {
	models: {
		tiers: {
			fast: { auto: "latest-haiku" },
			balanced: { auto: "latest-sonnet" },
			strong: { auto: "latest-opus" },
		},
		allowed_models: [],
		allow_unregistered: false,
	},
	search: {
		tier: "fast",
		include_synthesis: false,
		default_max_results: 10,
		global_allowed_domains: [],
		global_blocked_domains: [],
	},
	fetch: {
		summary_tier: "balanced",
		thinking_budget: null,
		answer_max_tokens: 4000,
		raw_max_bytes: 65536,
		request_timeout_ms: 30000,
		max_response_bytes: 10 * 1024 * 1024,
		follow_redirects: true,
		max_redirects: 5,
		user_agent_contact: "https://github.com/Boti-Ormandi/pi-web",
	},
	cache: {
		enabled: true,
		ttl_seconds: 900,
		max_entries: 200,
		persist_to_disk: false,
	},
	security: {
		allow_private_ips: false,
		allow_file_urls: false,
	},
	display: {
		show_cost: "always",
	},
};

export const PI_WEB_VERSION = "0.3.0";

export const USER_AGENT = (contact: string) =>
	`pi-web/${PI_WEB_VERSION} (+${contact})`;
