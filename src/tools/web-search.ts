import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
	callMessages,
	extractSearchAssistantBlocks,
	extractWebSearchResults,
	joinTextBlocks,
	type AnthropicResponse,
} from "../auth/anthropic.js";
import { WEB_SEARCH_TOOL_TYPE } from "../config/defaults.js";
import type { Config, TierName } from "../config/schema.js";
import { findExplicitModel, tierWithFallback, type RegistryLikeModel, type TierResolution } from "../models/tier-resolver.js";
import { MemoryCache, makeSearchCacheKey } from "../cache/store.js";
import { CitationContextCache } from "../cache/citation-context.js";
import { renderSearchCall, renderSearchResult } from "../ui/render-search.js";

export const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query. Required." }),
	max_results: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 10,
			description:
				"Number of results to return (1-10). Default 10. Anthropic's server-side web_search returns at most 10 results per call; higher values are not supported.",
		}),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Restrict results to these domains.",
		}),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), {
			description: "Exclude results from these domains.",
		}),
	),
	tier: Type.Optional(
		StringEnum(["fast", "balanced", "strong"] as const, {
			description: "Orchestrator model tier. Default fast. Wins over config but loses to orchestrator_model.",
		}),
	),
	orchestrator_model: Type.Optional(
		Type.String({
			description:
				'Explicit "provider/id" for the orchestrator model. Overrides tier. Only "anthropic/..." is supported (web_search is anthropic-side).',
		}),
	),
	include_synthesis: Type.Optional(
		Type.Boolean({
			description: "Include the orchestrator's free-text summary alongside the link list. Default false.",
		}),
	),
	bypass_cache: Type.Optional(Type.Boolean({ description: "Skip cache lookup; force a fresh search." })),
});

export type WebSearchInput = Static<typeof webSearchSchema>;

export interface WebSearchDetails {
	url?: string;
	model: string;
	tier?: TierName;
	cached: boolean;
	resultCount: number;
	results: Array<{
		title: string;
		url: string;
		pageAge?: string;
		encryptedContent?: string;
	}>;
	synthesis?: string;
	errorCode?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	cost?: number;
	elapsedMs: number;
}

interface ToolCacheValue {
	content: { type: "text"; text: string }[];
	details: WebSearchDetails;
}

export interface WebSearchToolOptions {
	getConfig: () => Config;
	getResolution: () => TierResolution;
	getRegistryModels: () => RegistryLikeModel[];
	cache: MemoryCache<ToolCacheValue>;
	citationContext: CitationContextCache;
	debug: () => boolean;
}

function buildUserMessage(input: WebSearchInput, maxResults: number, config: Config): string {
	const allowed = uniq([...(input.allowed_domains ?? []), ...config.search.global_allowed_domains]);
	const blocked = uniq([...(input.blocked_domains ?? []), ...config.search.global_blocked_domains]);
	const include = input.include_synthesis ?? config.search.include_synthesis;

	const parts: string[] = [];
	parts.push(`Perform a web search for the query: ${input.query}.`);
	parts.push(`Return up to ${maxResults} results.`);
	if (allowed.length > 0) parts.push(`Restrict results to: ${allowed.join(", ")}.`);
	if (blocked.length > 0) parts.push(`Exclude results from: ${blocked.join(", ")}.`);
	if (include) {
		parts.push("After the results, summarize the most relevant findings in 2-4 sentences.");
	} else {
		parts.push("Do not summarize. Return raw results only.");
	}
	return parts.join(" ");
}

function uniq(values: readonly string[]): string[] {
	return Array.from(new Set(values.filter((v) => typeof v === "string" && v.length > 0)));
}

function resolveOrchestratorModel(
	input: WebSearchInput,
	config: Config,
	resolution: TierResolution,
	models: RegistryLikeModel[],
): { ok: true; provider: string; id: string; tier?: TierName } | { ok: false; reason: string } {
	if (input.orchestrator_model) {
		const r = findExplicitModel(
			models,
			input.orchestrator_model,
			config.models.allow_unregistered,
			config.models.allowed_models,
		);
		if ("error" in r) return { ok: false, reason: r.error };
		if (r.provider !== "anthropic") {
			return { ok: false, reason: `web_search requires an anthropic orchestrator; got ${r.provider}` };
		}
		return { ok: true, provider: r.provider, id: r.id };
	}
	const tier = input.tier ?? config.search.tier;
	const resolved = tierWithFallback(resolution.tiers, tier);
	if (!resolved) {
		return { ok: false, reason: `No anthropic model available for tier "${tier}". Run /web-models or update pi's registry.` };
	}
	if (resolved.model.provider !== "anthropic") {
		return { ok: false, reason: `Tier "${tier}" resolved to non-anthropic provider ${resolved.model.provider}` };
	}
	return { ok: true, provider: resolved.model.provider, id: resolved.model.id, tier };
}

function formatResultsForLlm(results: WebSearchDetails["results"], synthesis: string | undefined, query: string): string {
	const lines: string[] = [];
	lines.push(`Web search results for "${query}":`);
	if (results.length === 0) {
		lines.push("  (no results)");
	}
	results.forEach((r, i) => {
		lines.push(`  ${i + 1}. ${r.title || "(no title)"}`);
		lines.push(`     ${r.url}`);
		if (r.pageAge) lines.push(`     page age: ${r.pageAge}`);
	});
	if (synthesis) {
		lines.push("");
		lines.push("Synthesis:");
		lines.push(synthesis);
	}
	return lines.join("\n");
}

function estimateCost(model: RegistryLikeModel | undefined, usage: { input_tokens?: number; output_tokens?: number } | undefined): number | undefined {
	if (!model || !usage) return undefined;
	const reg = model as RegistryLikeModel & { cost?: { input: number; output: number } };
	if (!reg.cost) return undefined;
	const inTok = usage.input_tokens ?? 0;
	const outTok = usage.output_tokens ?? 0;
	return (inTok * reg.cost.input + outTok * reg.cost.output) / 1_000_000;
}

function findRegistryModel(models: RegistryLikeModel[], provider: string, id: string): RegistryLikeModel | undefined {
	return models.find((m) => m.provider === provider && m.id === id);
}

function mapErrorToText(res: Extract<AnthropicResponse, { ok: false }>, modelId: string): { message: string; recoverable: boolean } {
	switch (res.category) {
		case "geo_restriction":
			return {
				message:
					"Anthropic web_search is US-only and your account/region is not eligible. Consider passing a specific URL to web_fetch instead.",
				recoverable: true,
			};
		case "rate_limit": {
			const reset =
				res.headers.get("anthropic-ratelimit-unified-5h-reset") ??
				res.headers.get("retry-after") ??
				"unknown";
			return {
				message: `Anthropic rate-limited. Reset window: ${reset}. Wait or pivot.`,
				recoverable: true,
			};
		}
		case "position_zero_gate":
			return {
				message:
					"pi-web internal error: position-0 gate rejected the request. This should not happen with the SDK preamble. Please file a bug.",
				recoverable: false,
			};
		case "classifier_third_party":
			return {
				message:
					"pi-web internal error: Anthropic classified this call as a third-party app. The pi-web `system` array should pass classification — please file a bug.",
				recoverable: false,
			};
		case "model_not_found":
			return {
				message:
					`Anthropic rejected model id "${modelId}". Pi's registry may be out of date for this account. Run /web-models or pin a different id.`,
				recoverable: true,
			};
		case "auth_failed":
			return {
				message: "Anthropic auth failed (401). Run `/login` to refresh your bearer.",
				recoverable: false,
			};
		default:
			return {
				message: `Anthropic error (${res.status}, ${res.errorType}): ${res.errorMessage}`,
				recoverable: res.status < 500,
			};
	}
}

export function createWebSearchTool(opts: WebSearchToolOptions): ToolDefinition<typeof webSearchSchema, WebSearchDetails> {
	return {
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Anthropic's server-side web_search tool. Returns titles, URLs, and snippets. " +
			"Use for 'what URLs are relevant' queries. For 'what does this specific page say', use web_fetch instead.",
		promptSnippet:
			"Search the web via Anthropic web_search (US-only). Returns titles and URLs for the query.",
		promptGuidelines: [
			"Use web_search for 'what URLs are relevant' queries. Use web_fetch for 'what does this specific page say' queries. Do not call web_fetch with a search-query-shaped URL.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const start = Date.now();
			const config = opts.getConfig();
			const resolution = opts.getResolution();
			const models = opts.getRegistryModels();

			const resolved = resolveOrchestratorModel(params, config, resolution, models);
			if (!resolved.ok) {
				throw new Error(resolved.reason);
			}

			const maxResults = Math.max(
				1,
				Math.min(10, params.max_results ?? config.search.default_max_results),
			);
			const allowed = uniq([...(params.allowed_domains ?? []), ...config.search.global_allowed_domains]);
			const blocked = uniq([...(params.blocked_domains ?? []), ...config.search.global_blocked_domains]);

			const cacheKey = makeSearchCacheKey({
				query: params.query,
				maxResults,
				allowedDomains: allowed,
				blockedDomains: blocked,
				model: `${resolved.provider}/${resolved.id}`,
			});

			if (!params.bypass_cache) {
				const hit = opts.cache.get(cacheKey);
				if (hit) {
					return {
						content: hit.content,
						details: { ...hit.details, cached: true, elapsedMs: Date.now() - start },
					};
				}
			}

			const bearer = await getAnthropicBearer(ctx);
			if (!bearer) {
				throw new Error("No anthropic bearer available. Run `/login` and try again.");
			}

			onUpdate?.({
				content: [{ type: "text", text: `Searching with ${resolved.provider}/${resolved.id}...` }],
				details: { url: undefined, model: `${resolved.provider}/${resolved.id}`, cached: false, resultCount: 0, results: [], elapsedMs: 0 } satisfies WebSearchDetails,
			});

			const response: AnthropicResponse = await callMessages({
				bearer,
				model: resolved.id,
				maxTokens: 4000,
				tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 3 }],
				messages: [
					{
						role: "user",
						content: buildUserMessage(params, maxResults, config),
					},
				],
				signal: signal ?? ctx.signal,
			});

			if (!response.ok) {
				const mapped = mapErrorToText(response, resolved.id);
				if (opts.debug()) {
					ctx.ui.notify(`web_search: ${response.errorType} (${response.status})`, "warning");
				}
				const details: WebSearchDetails = {
					model: `${resolved.provider}/${resolved.id}`,
					tier: resolved.tier,
					cached: false,
					resultCount: 0,
					results: [],
					errorCode: response.errorType,
					elapsedMs: Date.now() - start,
				};
				throw Object.assign(new Error(mapped.message), { recoverable: mapped.recoverable, details });
			}

			const { results: rawResults, errorCode } = extractWebSearchResults(response.message);
			const clipped = rawResults.slice(0, maxResults);
			const results: WebSearchDetails["results"] = clipped.map((r) => ({
				title: r.title ?? "",
				url: r.url ?? "",
				pageAge: r.page_age,
				encryptedContent: r.encrypted_content,
			}));

			const assistantBlocks = extractSearchAssistantBlocks(response.message);
			if (assistantBlocks && clipped.length > 0) {
				opts.citationContext.record({
					urls: clipped.map((r) => r.url ?? "").filter((u) => u.length > 0),
					query: params.query,
					assistantBlocks: assistantBlocks as unknown as Parameters<typeof opts.citationContext.record>[0]["assistantBlocks"],
				});
			}

			const synthesis = (params.include_synthesis ?? config.search.include_synthesis)
				? joinTextBlocks(response.message)
				: undefined;

			const text = formatResultsForLlm(results, synthesis, params.query);

			const cost = estimateCost(
				findRegistryModel(models, resolved.provider, resolved.id),
				response.message.usage,
			);

			const details: WebSearchDetails = {
				model: `${resolved.provider}/${resolved.id}`,
				tier: resolved.tier,
				cached: false,
				resultCount: results.length,
				results,
				synthesis,
				errorCode,
				usage: {
					input_tokens: response.message.usage?.input_tokens,
					output_tokens: response.message.usage?.output_tokens,
				},
				cost,
				elapsedMs: Date.now() - start,
			};

			const value: ToolCacheValue = {
				content: [{ type: "text", text }],
				details,
			};
			opts.cache.set(cacheKey, value, {
				sizeBytes: Buffer.byteLength(text, "utf8"),
				tag: "search",
			});

			return value;
		},
		renderCall: renderSearchCall,
		renderResult: renderSearchResult,
	};
}

async function getAnthropicBearer(ctx: ExtensionContext): Promise<string | undefined> {
	try {
		return await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	} catch {
		return undefined;
	}
}
