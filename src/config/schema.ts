export type TierName = "fast" | "balanced" | "strong";

export type CostDisplay = "always" | "debug" | "never";

export type TierConfig = string | { auto: "latest-haiku" | "latest-sonnet" | "latest-opus" };

export interface ModelsConfig {
	tiers: Record<TierName, TierConfig>;
	allowed_models: string[];
	allow_unregistered: boolean;
}

export interface SearchConfig {
	tier: TierName;
	include_synthesis: boolean;
	default_max_results: number;
	global_allowed_domains: string[];
	global_blocked_domains: string[];
}

export interface FetchConfig {
	summary_tier: TierName;
	thinking_budget: number | null;
	answer_max_tokens: number;
	raw_max_bytes: number;
	request_timeout_ms: number;
	max_response_bytes: number;
	follow_redirects: boolean;
	max_redirects: number;
	user_agent_contact: string;
}

export interface CacheConfig {
	enabled: boolean;
	ttl_seconds: number;
	max_entries: number;
	persist_to_disk: boolean;
}

export interface SecurityConfig {
	allow_private_ips: boolean;
	allow_file_urls: boolean;
}

export interface DisplayConfig {
	show_cost: CostDisplay;
}

export interface Config {
	models: ModelsConfig;
	search: SearchConfig;
	fetch: FetchConfig;
	cache: CacheConfig;
	security: SecurityConfig;
	display: DisplayConfig;
}

export type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type PartialConfig = DeepPartial<Config>;

export interface ConfigSource {
	label: string;
	path?: string;
	value: PartialConfig;
}

export interface ResolvedConfig {
	config: Config;
	sources: ConfigSource[];
}
