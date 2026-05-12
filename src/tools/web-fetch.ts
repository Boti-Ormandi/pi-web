import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { StringEnum, type Api, type Model } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
	callMessages,
	decodeFetchedDocument,
	extractWebFetchResult,
	joinTextBlocks,
	mapServerFetchErrorCode,
	summarizeThinking,
	type AnthropicResponse,
} from "../auth/anthropic.js";
import { summarizeViaPiAi } from "../auth/provider-router.js";
import { CitationContextCache } from "../cache/citation-context.js";
import { MemoryCache, makeFetchCacheKey } from "../cache/store.js";
import {
	PREAMBLE,
	SERVER_FETCH_DEFAULT_MAX_CONTENT_TOKENS,
	WEB_FETCH_TOOL_TYPE,
} from "../config/defaults.js";
import type { Config, TierName } from "../config/schema.js";
import { extractContent, type ExtractionResult } from "../fetch/extract.js";
import { httpFetch } from "../fetch/http.js";
import { truncateByBytes, truncateForTokens } from "../fetch/truncate.js";
import {
	findExplicitModel,
	tierWithFallback,
	type RegistryLikeModel,
	type TierResolution,
} from "../models/tier-resolver.js";
import { renderFetchCall, renderFetchResult } from "../ui/render-fetch.js";

export const webFetchSchema = Type.Object({
	url: Type.String({ description: "Target URL. http(s) only. Required." }),
	prompt: Type.Optional(
		Type.String({
			description:
				"What to extract from the page. If provided, the tool runs a side-channel summarization. If omitted, mode defaults to raw.",
		}),
	),
	mode: Type.Optional(
		StringEnum(["raw", "summary", "auto"] as const, {
			description:
				"raw = return cleaned markdown directly. summary = side-channel model call. auto = summary if prompt given, else raw.",
		}),
	),
	summary_tier: Type.Optional(
		StringEnum(["fast", "balanced", "strong"] as const, {
			description: "Summarizer model tier. Default balanced.",
		}),
	),
	summary_model: Type.Optional(
		Type.String({
			description: 'Explicit "provider/id" override for the summarizer. Wins over tier.',
		}),
	),
	thinking_budget: Type.Optional(
		Type.Integer({
			minimum: 1024,
			maximum: 32000,
			description: "Anthropic thinking budget. Only applied if the resolved model supports reasoning.",
		}),
	),
	answer_max_tokens: Type.Optional(
		Type.Integer({ minimum: 256, maximum: 16000, description: "Output budget for the summarizer." }),
	),
	raw_max_bytes: Type.Optional(
		Type.Integer({
			minimum: 1024,
			description: "Cap on raw-mode markdown returned to the main model. Defaults to config.fetch.raw_max_bytes.",
		}),
	),
	bypass_cache: Type.Optional(Type.Boolean({ description: "Skip cache lookup; force a fresh fetch." })),
	backend: Type.Optional(
		StringEnum(["client", "server"] as const, {
			description:
				'Fetch backend. "client" (default) does the GET + extract on this machine. "server" routes through Anthropic\'s server-side web_fetch tool; if the URL came from a recent web_search the prior search turn is replayed for citation continuity.',
		}),
	),
	max_content_tokens: Type.Optional(
		Type.Integer({
			minimum: 1024,
			maximum: 200_000,
			description:
				"Server-backend only. Caps Anthropic's per-fetch content truncation before the orchestrator reads the page. Default 100000.",
		}),
	),
	require_fetch: Type.Optional(
		Type.Boolean({
			description:
				'Server-backend only. When true (default), pi-web errors if Anthropic\'s orchestrator skipped web_fetch and answered from prior knowledge. Set false to accept prior-knowledge answers (a clear skip-note is prepended to the result).',
		}),
	),
});

export type WebFetchInput = Static<typeof webFetchSchema>;

export interface WebFetchDetails {
	url: string;
	finalUrl?: string;
	mode: "raw" | "summary";
	backend?: "client" | "server";
	httpStatus?: number;
	contentType?: string;
	bytesIn: number;
	bytesOut: number;
	pageTitle?: string;
	usedReadability?: boolean;
	contentKind?: "html" | "json" | "text" | "binary" | "pdf";
	pageCount?: number;
	model?: string;
	tier?: TierName;
	thinkingFired?: boolean;
	thinkingSignatureChars?: number;
	thinkingUnavailable?: boolean;
	pageTruncated?: boolean;
	pageOriginalChars?: number;
	cached: boolean;
	elapsedMs: number;
	cost?: number;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	error?: string;
	recoverable?: boolean;
	redirectChain?: string[];
	citationLinked?: boolean;
	citationQuery?: string;
	retrievedAt?: string;
	serverFetchErrorCode?: string;
	serverFetchInvoked?: boolean;
	maxContentTokens?: number;
}

interface ToolCacheValue {
	content: { type: "text"; text: string }[];
	details: WebFetchDetails;
}

export interface WebFetchToolOptions {
	getConfig: () => Config;
	getResolution: () => TierResolution;
	getRegistryModels: () => RegistryLikeModel[];
	cache: MemoryCache<ToolCacheValue>;
	citationContext: CitationContextCache;
	debug: () => boolean;
}

function decideMode(input: WebFetchInput): "raw" | "summary" {
	if (input.mode === "raw") return "raw";
	if (input.mode === "summary") return "summary";
	return input.prompt ? "summary" : "raw";
}

function resolveSummarizer(
	input: WebFetchInput,
	config: Config,
	resolution: TierResolution,
	models: RegistryLikeModel[],
): { ok: true; provider: string; id: string; tier?: TierName; model?: RegistryLikeModel } | { ok: false; reason: string } {
	if (input.summary_model) {
		const r = findExplicitModel(
			models,
			input.summary_model,
			config.models.allow_unregistered,
			config.models.allowed_models,
		);
		if ("error" in r) return { ok: false, reason: r.error };
		return { ok: true, provider: r.provider, id: r.id, model: r };
	}
	const tier = input.summary_tier ?? config.fetch.summary_tier;
	const resolved = tierWithFallback(resolution.tiers, tier);
	if (!resolved) {
		return { ok: false, reason: `No model available for tier "${tier}". Run /web-models.` };
	}
	return { ok: true, provider: resolved.model.provider, id: resolved.model.id, tier, model: resolved.model };
}

function buildSummaryUserMessage(args: {
	finalUrl: string;
	prompt: string | undefined;
	pageMarkdown: string;
	pageTitle: string | undefined;
	truncated: boolean;
	originalChars: number;
}): string {
	const parts: string[] = [];
	parts.push(`Web page content (from ${args.finalUrl}${args.pageTitle ? ` — "${args.pageTitle}"` : ""}):`);
	parts.push("");
	parts.push(args.pageMarkdown);
	parts.push("");
	if (args.truncated) {
		parts.push(`Note: the page was truncated from ~${args.originalChars} characters to fit the model's context window.`);
		parts.push("");
	}
	parts.push("---");
	parts.push("");
	if (args.prompt) {
		parts.push(args.prompt);
	} else {
		parts.push("Summarize the page above in 5-8 sentences. Be specific. Cite concrete facts, not generalities.");
	}
	return parts.join("\n");
}

function estimateCost(model: RegistryLikeModel | undefined, usage: { input_tokens?: number; output_tokens?: number } | undefined): number | undefined {
	if (!model || !usage) return undefined;
	const reg = model as RegistryLikeModel & { cost?: { input: number; output: number } };
	if (!reg.cost) return undefined;
	const inTok = usage.input_tokens ?? 0;
	const outTok = usage.output_tokens ?? 0;
	return (inTok * reg.cost.input + outTok * reg.cost.output) / 1_000_000;
}

function mapErrorToText(res: Extract<AnthropicResponse, { ok: false }>, modelId: string): { message: string; recoverable: boolean } {
	switch (res.category) {
		case "rate_limit": {
			const reset =
				res.headers.get("anthropic-ratelimit-unified-5h-reset") ??
				res.headers.get("retry-after") ??
				"unknown";
			return {
				message: `Anthropic rate-limited (summarizer call). Reset window: ${reset}.`,
				recoverable: true,
			};
		}
		case "position_zero_gate":
			return {
				message:
					"pi-web internal error: position-0 gate rejected the summarizer request. Please file a bug.",
				recoverable: false,
			};
		case "classifier_third_party":
			return {
				message:
					"pi-web internal error: Anthropic classified the summarizer call as a third-party app. Please file a bug.",
				recoverable: false,
			};
		case "model_not_found":
			return {
				message: `Anthropic rejected model id "${modelId}". Pi's registry may need updating.`,
				recoverable: true,
			};
		case "auth_failed":
			return { message: "Anthropic auth failed (401). Run `/login`.", recoverable: false };
		default:
			return {
				message: `Anthropic summarizer error (${res.status}, ${res.errorType}): ${res.errorMessage}`,
				recoverable: res.status < 500,
			};
	}
}

function formatRawForLlm(args: {
	finalUrl: string;
	title: string | undefined;
	siteName: string | undefined;
	markdown: string;
	truncatedTo: number;
	originalBytes: number;
}): string {
	const header: string[] = [];
	header.push(`Fetched: ${args.finalUrl}`);
	if (args.title) header.push(`Title: ${args.title}`);
	if (args.siteName) header.push(`Site: ${args.siteName}`);
	header.push(`Bytes: ${args.originalBytes}, returned as markdown: ${args.markdown.length} chars`);
	if (args.markdown.length < args.originalBytes && args.truncatedTo > 0) {
		header.push("Note: content was truncated to fit raw_max_bytes; pass a higher cap or use mode=summary.");
	}
	return header.join("\n") + "\n\n---\n\n" + args.markdown;
}

export function createWebFetchTool(opts: WebFetchToolOptions): ToolDefinition<typeof webFetchSchema, WebFetchDetails> {
	return {
		name: "web_fetch",
		label: "Web Fetch",
		description:
			"Fetch a URL and return its content. Modes: raw (cleaned markdown), summary (side-channel model summarization with optional thinking), or auto (summary if prompt given). " +
			'Set backend="server" to route through Anthropic\'s server-side web_fetch with citation continuity for URLs that came from a recent web_search. ' +
			"For 'what URLs are relevant' queries, use web_search instead.",
		promptSnippet:
			"Fetch a URL and return cleaned markdown or a side-channel summary (with optional thinking).",
		promptGuidelines: [
			"Pass an explicit prompt to web_fetch describing what you need from the page. Generic summarization wastes tokens.",
			'Pick summary_tier on web_fetch based on task complexity: "fast" for routine doc lookups, "balanced" for the default (handles large pages natively), "strong" for research-grade synthesis.',
			"Set thinking_budget on web_fetch only when the task is genuinely reasoning-heavy (constrained math, multi-source comparison, careful trade-off analysis).",
			"web_fetch handles PDFs as well as HTML. Page boundaries are preserved as '## Page N' headings; cite by page number when answering from a PDF.",
			'When following up on a specific URL from a recent web_search result and citation linkage matters, set backend="server". Server mode always pays for an orchestrator turn (no raw mode) and is anthropic-only.',
		],
		parameters: webFetchSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const start = Date.now();
			const config = opts.getConfig();
			const resolution = opts.getResolution();
			const models = opts.getRegistryModels();

			if (params.backend === "server") {
				return executeServerFetch({
					params,
					config,
					resolution,
					models,
					opts,
					ctx,
					signal,
					onUpdate,
					start,
				});
			}

			const mode = decideMode(params);

			const summarizer =
				mode === "summary"
					? resolveSummarizer(params, config, resolution, models)
					: undefined;
			if (summarizer && !summarizer.ok) {
				throw new Error(summarizer.reason);
			}

			const summaryModelKey =
				summarizer && summarizer.ok ? `${summarizer.provider}/${summarizer.id}` : undefined;

			const cacheKey = makeFetchCacheKey({
				url: params.url,
				mode,
				prompt: params.prompt,
				model: summaryModelKey,
				thinkingBudget: params.thinking_budget ?? null,
				rawMaxBytes: mode === "raw" ? params.raw_max_bytes ?? config.fetch.raw_max_bytes : undefined,
				backend: "client",
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

			onUpdate?.({
				content: [{ type: "text", text: `Resolving ${params.url}...` }],
				details: {
					url: params.url,
					mode,
					bytesIn: 0,
					bytesOut: 0,
					cached: false,
					elapsedMs: 0,
				} satisfies WebFetchDetails,
			});
			const httpOutcome = await httpFetch(params.url, {
				allowFileUrls: config.security.allow_file_urls,
				allowPrivateIps: config.security.allow_private_ips,
				maxResponseBytes: config.fetch.max_response_bytes,
				requestTimeoutMs: config.fetch.request_timeout_ms,
				maxRedirects: config.fetch.max_redirects,
				followRedirects: config.fetch.follow_redirects,
				userAgentContact: config.fetch.user_agent_contact,
				signal: signal ?? ctx.signal,
				onProgress: (msg) => {
					onUpdate?.({
						content: [{ type: "text", text: msg }],
						details: {
							url: params.url,
							mode,
							bytesIn: 0,
							bytesOut: 0,
							cached: false,
							elapsedMs: Date.now() - start,
						} satisfies WebFetchDetails,
					});
				},
			});

			if (!httpOutcome.ok) {
				const details: WebFetchDetails = {
					url: params.url,
					finalUrl: httpOutcome.finalUrl,
					mode,
					httpStatus: httpOutcome.status,
					bytesIn: 0,
					bytesOut: 0,
					cached: false,
					elapsedMs: Date.now() - start,
					error: httpOutcome.reason,
					recoverable: true,
				};
				throw Object.assign(new Error(httpOutcome.reason), { details, recoverable: true });
			}

			onUpdate?.({
				content: [{ type: "text", text: `Extracting (${httpOutcome.contentLength} bytes)...` }],
				details: {
					url: params.url,
					finalUrl: httpOutcome.finalUrl,
					mode,
					bytesIn: httpOutcome.contentLength,
					bytesOut: 0,
					cached: false,
					elapsedMs: Date.now() - start,
				} satisfies WebFetchDetails,
			});

			const extraction: ExtractionResult = await extractContent(httpOutcome.body, httpOutcome.contentType);

			if (mode === "raw") {
				const rawCap = params.raw_max_bytes ?? config.fetch.raw_max_bytes;
				const truncated = truncateByBytes(extraction.markdown, rawCap);
				const text = formatRawForLlm({
					finalUrl: httpOutcome.finalUrl,
					title: extraction.title,
					siteName: extraction.siteName,
					markdown: truncated.text,
					truncatedTo: rawCap,
					originalBytes: httpOutcome.contentLength,
				});
				const details: WebFetchDetails = {
					url: params.url,
					finalUrl: httpOutcome.finalUrl,
					mode: "raw",
					backend: "client",
					httpStatus: httpOutcome.status,
					contentType: httpOutcome.contentType,
					bytesIn: httpOutcome.contentLength,
					bytesOut: Buffer.byteLength(text, "utf8"),
					pageTitle: extraction.title,
					usedReadability: extraction.usedReadability,
					contentKind: extraction.kind,
					pageCount: extraction.pageCount,
					pageTruncated: truncated.truncated,
					pageOriginalChars: extraction.markdown.length,
					cached: false,
					elapsedMs: Date.now() - start,
					redirectChain: httpOutcome.redirectChain.length > 0 ? httpOutcome.redirectChain : undefined,
				};
				const value: ToolCacheValue = {
					content: [{ type: "text", text }],
					details,
				};
				opts.cache.set(cacheKey, value, {
					sizeBytes: Buffer.byteLength(text, "utf8"),
					tag: "fetch-raw",
				});
				return value;
			}

			if (!summarizer || !summarizer.ok) {
				throw new Error("Internal: summarizer not resolved");
			}

			const registryModel = summarizer.model ?? findRegistryModel(models, summarizer.provider, summarizer.id);
			const modelContextWindow = registryModel?.contextWindow ?? 200_000;
			const promptOverhead = 1500;
			const answerMax = params.answer_max_tokens ?? config.fetch.answer_max_tokens;
			const thinkingBudgetRequested = params.thinking_budget ?? config.fetch.thinking_budget;
			const supportsReasoning = registryModel?.reasoning ?? false;
			const thinkingBudget = thinkingBudgetRequested && supportsReasoning ? thinkingBudgetRequested : undefined;
			const thinkingUnavailable = !!thinkingBudgetRequested && !supportsReasoning;
			const inputBudgetTokens = Math.max(
				1024,
				modelContextWindow - answerMax - (thinkingBudget ?? 0) - promptOverhead,
			);

			const truncated = truncateForTokens(extraction.markdown, inputBudgetTokens);

			onUpdate?.({
				content: [
					{
						type: "text",
						text: `Summarizing with ${summarizer.provider}/${summarizer.id}${thinkingBudget ? ` (thinking ${thinkingBudget})` : ""}`,
					},
				],
				details: {
					url: params.url,
					finalUrl: httpOutcome.finalUrl,
					mode: "summary",
					bytesIn: httpOutcome.contentLength,
					bytesOut: 0,
					cached: false,
					model: `${summarizer.provider}/${summarizer.id}`,
					tier: summarizer.tier,
					elapsedMs: Date.now() - start,
				} satisfies WebFetchDetails,
			});

			const userText = buildSummaryUserMessage({
				finalUrl: httpOutcome.finalUrl,
				prompt: params.prompt,
				pageMarkdown: truncated.text,
				pageTitle: extraction.title,
				truncated: truncated.truncated,
				originalChars: truncated.originalChars,
			});

			const isAnthropic = summarizer.provider === "anthropic";
			let summaryText: string;
			let thinking: { fired: boolean; signatureChars: number };
			let usageIn: number | undefined;
			let usageOut: number | undefined;
			let cost: number | undefined;
			let routingError: { message: string; recoverable: boolean } | undefined;

			if (isAnthropic) {
				const bearer = await getAnthropicBearer(ctx);
				if (!bearer) throw new Error("No anthropic bearer available. Run `/login`.");
				const maxTokens = answerMax + (thinkingBudget ?? 0);
				const response: AnthropicResponse = await callMessages({
					bearer,
					model: summarizer.id,
					maxTokens,
					thinking: thinkingBudget ? { type: "enabled", budget_tokens: thinkingBudget } : undefined,
					messages: [{ role: "user", content: userText }],
					signal: signal ?? ctx.signal,
				});
				if (!response.ok) {
					routingError = mapErrorToText(response, summarizer.id);
					if (opts.debug()) {
						ctx.ui.notify(`web_fetch summarizer: ${response.errorType} (${response.status})`, "warning");
					}
					summaryText = "";
					thinking = { fired: false, signatureChars: 0 };
				} else {
					summaryText = joinTextBlocks(response.message);
					thinking = summarizeThinking(response.message);
					usageIn = response.message.usage?.input_tokens;
					usageOut = response.message.usage?.output_tokens;
					cost = estimateCost(registryModel, response.message.usage);
				}
			} else {
				const model = ctx.modelRegistry.find(summarizer.provider, summarizer.id);
				if (!model) {
					routingError = {
						message: `Provider ${summarizer.provider}/${summarizer.id} not in registry; cannot route summarizer call.`,
						recoverable: false,
					};
					summaryText = "";
					thinking = { fired: false, signatureChars: 0 };
				} else {
					const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
					if (!auth.ok) {
						routingError = {
							message: `Auth resolution failed for ${summarizer.provider}/${summarizer.id}: ${auth.error}`,
							recoverable: false,
						};
						summaryText = "";
						thinking = { fired: false, signatureChars: 0 };
					} else {
						const routed = await summarizeViaPiAi({
							model: model as Model<Api>,
							apiKey: auth.apiKey,
							headers: auth.headers,
							systemText: PREAMBLE,
							userText,
							answerMaxTokens: answerMax,
							thinkingBudget,
							signal: signal ?? ctx.signal,
						});
						if (!routed.ok) {
							routingError = { message: routed.reason, recoverable: routed.recoverable };
							if (opts.debug()) ctx.ui.notify(`web_fetch summarizer: ${routed.reason}`, "warning");
							summaryText = "";
							thinking = { fired: false, signatureChars: 0 };
						} else {
							summaryText = routed.text;
							thinking = { fired: routed.thinkingFired, signatureChars: routed.thinkingSignatureChars };
							usageIn = routed.usage.input_tokens;
							usageOut = routed.usage.output_tokens;
							cost = routed.cost;
						}
					}
				}
			}

			if (routingError) {
				const mapped = routingError;
				const details: WebFetchDetails = {
					url: params.url,
					finalUrl: httpOutcome.finalUrl,
					mode: "summary",
					backend: "client",
					httpStatus: httpOutcome.status,
					contentType: httpOutcome.contentType,
					bytesIn: httpOutcome.contentLength,
					bytesOut: 0,
					pageTitle: extraction.title,
					usedReadability: extraction.usedReadability,
					contentKind: extraction.kind,
					pageCount: extraction.pageCount,
					pageTruncated: truncated.truncated,
					pageOriginalChars: extraction.markdown.length,
					model: `${summarizer.provider}/${summarizer.id}`,
					tier: summarizer.tier,
					cached: false,
					elapsedMs: Date.now() - start,
					error: mapped.message,
					recoverable: mapped.recoverable,
				};
				throw Object.assign(new Error(mapped.message), { details, recoverable: mapped.recoverable });
			}

			const llmText = [
				`Fetched: ${httpOutcome.finalUrl}`,
				extraction.title ? `Title: ${extraction.title}` : undefined,
				`Summarized via ${summarizer.provider}/${summarizer.id}${thinking.fired ? " (thinking on)" : ""}`,
				truncated.truncated ? `Note: page truncated from ~${truncated.originalChars} chars.` : undefined,
				"",
				summaryText || "(no summary text returned)",
			]
				.filter((s): s is string => typeof s === "string")
				.join("\n");

			const details: WebFetchDetails = {
				url: params.url,
				finalUrl: httpOutcome.finalUrl,
				mode: "summary",
				backend: "client",
				httpStatus: httpOutcome.status,
				contentType: httpOutcome.contentType,
				bytesIn: httpOutcome.contentLength,
				bytesOut: Buffer.byteLength(llmText, "utf8"),
				pageTitle: extraction.title,
				usedReadability: extraction.usedReadability,
				contentKind: extraction.kind,
				pageCount: extraction.pageCount,
				model: `${summarizer.provider}/${summarizer.id}`,
				tier: summarizer.tier,
				thinkingFired: thinking.fired,
				thinkingSignatureChars: thinking.signatureChars,
				thinkingUnavailable: thinkingUnavailable || undefined,
				pageTruncated: truncated.truncated,
				pageOriginalChars: extraction.markdown.length,
				cached: false,
				elapsedMs: Date.now() - start,
				cost,
				usage: { input_tokens: usageIn, output_tokens: usageOut },
				redirectChain: httpOutcome.redirectChain.length > 0 ? httpOutcome.redirectChain : undefined,
			};
			const value: ToolCacheValue = {
				content: [{ type: "text", text: llmText }],
				details,
			};
			opts.cache.set(cacheKey, value, {
				sizeBytes: Buffer.byteLength(llmText, "utf8"),
				tag: "fetch-summary",
			});
			return value;
		},
		renderCall: renderFetchCall,
		renderResult: renderFetchResult,
	};
}

function findRegistryModel(models: RegistryLikeModel[], provider: string, id: string): RegistryLikeModel | undefined {
	return models.find((m) => m.provider === provider && m.id === id);
}

async function getAnthropicBearer(ctx: ExtensionContext): Promise<string | undefined> {
	try {
		return await ctx.modelRegistry.getApiKeyForProvider("anthropic");
	} catch {
		return undefined;
	}
}

// -----------------------------------------------------------------------
// Server-side backend (backend: "server")
//
// Routes the fetch through Anthropic's server-side web_fetch_20250910
// tool. When the URL came from a recent web_search the prior assistant
// turn (server_tool_use + web_search_tool_result) is replayed into the
// conversation for citation continuity. The pipeline is intentionally
// flatter than client mode: Anthropic handles GET, extraction, and the
// orchestrator turn in one /v1/messages call.
// -----------------------------------------------------------------------

interface ServerFetchArgs {
	params: WebFetchInput;
	config: Config;
	resolution: TierResolution;
	models: RegistryLikeModel[];
	opts: WebFetchToolOptions;
	ctx: ExtensionContext;
	signal?: AbortSignal;
	onUpdate?: (chunk: { content: { type: "text"; text: string }[]; details: WebFetchDetails }) => void;
	start: number;
}

async function executeServerFetch(args: ServerFetchArgs): Promise<ToolCacheValue> {
	const { params, config, resolution, models, opts, ctx, signal, onUpdate, start } = args;

	const summarizer = resolveSummarizer(params, config, resolution, models);
	if (!summarizer.ok) throw new Error(summarizer.reason);
	if (summarizer.provider !== "anthropic") {
		throw new Error(
			`Server backend is anthropic-only; got ${summarizer.provider}/${summarizer.id}. ` +
				"Use backend=\"client\" with this summarizer or pick an anthropic tier/model.",
		);
	}

	const maxContentTokens = params.max_content_tokens ?? SERVER_FETCH_DEFAULT_MAX_CONTENT_TOKENS;
	const summaryModelKey = `${summarizer.provider}/${summarizer.id}`;

	const cacheKey = makeFetchCacheKey({
		url: params.url,
		mode: "summary",
		prompt: params.prompt,
		model: summaryModelKey,
		thinkingBudget: null,
		backend: "server",
		maxContentTokens,
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
	if (!bearer) throw new Error("No anthropic bearer available. Run `/login` and try again.");

	const citation = opts.citationContext.get(params.url);
	const citationLinked = !!citation;

	const messages = buildServerFetchMessages({
		url: params.url,
		prompt: params.prompt,
		citation,
	});

	onUpdate?.({
		content: [
			{
				type: "text",
				text: `Server-fetching via ${summarizer.id}${citationLinked ? " (citation-linked)" : ""}...`,
			},
		],
		details: {
			url: params.url,
			mode: "summary",
			backend: "server",
			bytesIn: 0,
			bytesOut: 0,
			cached: false,
			model: summaryModelKey,
			tier: summarizer.tier,
			citationLinked,
			citationQuery: citation?.query,
			maxContentTokens,
			elapsedMs: Date.now() - start,
		},
	});
	const answerMax = params.answer_max_tokens ?? config.fetch.answer_max_tokens;
	const response: AnthropicResponse = await callMessages({
		bearer,
		model: summarizer.id,
		maxTokens: answerMax,
		tools: [
			{
				type: WEB_FETCH_TOOL_TYPE,
				name: "web_fetch",
				max_uses: 1,
				citations: { enabled: true },
				max_content_tokens: maxContentTokens,
			},
		],
		messages,
		signal: signal ?? ctx.signal,
	});

	const registryModel = summarizer.model ?? findRegistryModel(models, summarizer.provider, summarizer.id);

	if (!response.ok) {
		const mapped = anthropicErrorToText(response, summarizer.id);
		if (opts.debug()) ctx.ui.notify(`web_fetch [server]: ${response.errorType} (${response.status})`, "warning");
		const details: WebFetchDetails = {
			url: params.url,
			mode: "summary",
			backend: "server",
			bytesIn: 0,
			bytesOut: 0,
			model: summaryModelKey,
			tier: summarizer.tier,
			citationLinked,
			citationQuery: citation?.query,
			maxContentTokens,
			cached: false,
			elapsedMs: Date.now() - start,
			error: mapped.message,
			recoverable: mapped.recoverable,
		};
		throw Object.assign(new Error(mapped.message), { details, recoverable: mapped.recoverable });
	}

	const fetchResult = extractWebFetchResult(response.message);
	const answerText = joinTextBlocks(response.message);
	const serverFetchInvoked = fetchResult !== undefined;

	let pageTitle: string | undefined;
	let retrievedAt: string | undefined;
	let finalUrl: string | undefined;
	let contentKind: WebFetchDetails["contentKind"];
	let bytesIn = 0;
	let serverFetchErrorCode: string | undefined;
	let serverFetchErrorMessage: string | undefined;
	let serverFetchRecoverable = true;

	if (fetchResult) {
		if (fetchResult.type === "web_fetch_result") {
			pageTitle = fetchResult.content?.title;
			retrievedAt = fetchResult.retrieved_at;
			finalUrl = fetchResult.url;
			const decoded = decodeFetchedDocument(fetchResult);
			bytesIn = decoded.byteLength;
			contentKind = decoded.isPdf ? "pdf" : "html";
		} else {
			serverFetchErrorCode = fetchResult.error_code;
			const mapped = mapServerFetchErrorCode(fetchResult.error_code);
			serverFetchErrorMessage = mapped.message;
			serverFetchRecoverable = mapped.recoverable;
		}
	}

	const usage = response.message.usage;
	const cost = estimateCost(registryModel, usage);
	const requireFetch = params.require_fetch ?? true;

	if (!serverFetchInvoked && requireFetch) {
		const message =
			`Anthropic's orchestrator skipped web_fetch for ${params.url} and answered from prior knowledge. ` +
			`Retry with a more specific prompt, switch to backend="client", or set require_fetch=false to ` +
			`accept prior-knowledge answers.`;
		const details: WebFetchDetails = {
			url: params.url,
			mode: "summary",
			backend: "server",
			bytesIn: 0,
			bytesOut: 0,
			model: summaryModelKey,
			tier: summarizer.tier,
			citationLinked,
			citationQuery: citation?.query,
			maxContentTokens,
			serverFetchInvoked: false,
			cached: false,
			elapsedMs: Date.now() - start,
			cost,
			usage: {
				input_tokens: usage?.input_tokens,
				output_tokens: usage?.output_tokens,
			},
			error: message,
			recoverable: true,
		};
		throw Object.assign(new Error(message), { details, recoverable: true });
	}

	const llmText = buildServerFetchLlmText({
		url: params.url,
		finalUrl,
		pageTitle,
		retrievedAt,
		citationLinked,
		citationQuery: citation?.query,
		answerText,
		serverFetchErrorMessage,
		serverFetchInvoked,
	});

	const details: WebFetchDetails = {
		url: params.url,
		finalUrl,
		mode: "summary",
		backend: "server",
		bytesIn,
		bytesOut: Buffer.byteLength(llmText, "utf8"),
		pageTitle,
		contentKind,
		model: summaryModelKey,
		tier: summarizer.tier,
		cached: false,
		elapsedMs: Date.now() - start,
		cost,
		usage: {
			input_tokens: usage?.input_tokens,
			output_tokens: usage?.output_tokens,
		},
		citationLinked,
		citationQuery: citation?.query,
		retrievedAt,
		serverFetchErrorCode,
		serverFetchInvoked,
		maxContentTokens,
		error: serverFetchErrorMessage,
		recoverable: serverFetchErrorMessage ? serverFetchRecoverable : undefined,
	};

	const value: ToolCacheValue = {
		content: [{ type: "text", text: llmText }],
		details,
	};
	if (serverFetchInvoked && !serverFetchErrorCode) {
		opts.cache.set(cacheKey, value, {
			sizeBytes: Buffer.byteLength(llmText, "utf8"),
			tag: "fetch-server",
		});
	}
	return value;
}

export function buildServerFetchMessages(args: {
	url: string;
	prompt: string | undefined;
	citation: ReturnType<CitationContextCache["get"]>;
}): Array<{ role: "user" | "assistant"; content: string | unknown[] }> {
	const questionLine = args.prompt
		? args.prompt
		: "Return the page content as cleaned markdown. Be comprehensive; preserve headings, lists, and code blocks. Do not summarize beyond removing boilerplate.";

	const imperative =
		`Use your web_fetch tool to retrieve the live content of the following URL. ` +
		`Do not answer from prior knowledge — always invoke the tool before answering.`;

	if (args.citation) {
		const userSearch = `Perform a web search for the query: ${args.citation.query}.`;
		const userFetch =
			`${imperative}\n\n` +
			`URL: ${args.url}\n\n` +
			`After fetching, answer this follow-up using the search results above for context: ${questionLine}`;
		return [
			{ role: "user", content: userSearch },
			{ role: "assistant", content: args.citation.assistantBlocks as unknown[] },
			{ role: "user", content: userFetch },
		];
	}

	const single =
		`${imperative}\n\n` +
		`URL: ${args.url}\n\n` +
		`After fetching, answer this: ${questionLine}`;
	return [{ role: "user", content: single }];
}

function buildServerFetchLlmText(args: {
	url: string;
	finalUrl: string | undefined;
	pageTitle: string | undefined;
	retrievedAt: string | undefined;
	citationLinked: boolean;
	citationQuery: string | undefined;
	answerText: string;
	serverFetchErrorMessage: string | undefined;
	serverFetchInvoked: boolean;
}): string {
	const sections: string[] = [];
	if (!args.serverFetchInvoked) {
		sections.push(
			'Note: Anthropic\'s orchestrator chose not to invoke web_fetch for this URL. ' +
				"The answer below reflects the model's prior knowledge, not the live page. " +
				'Retry with a more specific prompt, or use backend="client", if fresh content is required.',
		);
	}
	const header: string[] = [];
	header.push(`Fetched (server backend): ${args.finalUrl ?? args.url}`);
	if (args.pageTitle) header.push(`Title: ${args.pageTitle}`);
	if (args.retrievedAt) header.push(`Retrieved at: ${args.retrievedAt}`);
	header.push(
		args.citationLinked && args.citationQuery
			? `Citation continuity: linked to prior web_search "${args.citationQuery}"`
			: "Citation continuity: not linked (URL not from a recent web_search)",
	);
	if (!args.serverFetchInvoked) header.push("Fetch invoked: no (model answered from prior knowledge)");
	if (args.serverFetchErrorMessage) header.push(`Server-fetch error: ${args.serverFetchErrorMessage}`);
	sections.push(header.join("\n") + "\n\n---\n\n" + (args.answerText || "(no answer text returned)"));
	return sections.join("\n\n");
}

function anthropicErrorToText(
	res: Extract<AnthropicResponse, { ok: false }>,
	modelId: string,
): { message: string; recoverable: boolean } {
	return mapErrorToText(res, modelId);
}
