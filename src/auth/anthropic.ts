import {
	ANTHROPIC_API_URL,
	ANTHROPIC_BETA_HEADER,
	ANTHROPIC_VERSION_HEADER,
	PREAMBLE,
} from "../config/defaults.js";

export interface AnthropicTextBlock {
	type: "text";
	text: string;
}

export interface AnthropicThinkingBlock {
	type: "thinking" | "redacted_thinking";
	thinking?: string;
	signature?: string;
	data?: string;
}

export interface AnthropicToolUseBlock {
	type: "tool_use" | "server_tool_use";
	id: string;
	name: string;
	input: unknown;
}

export interface AnthropicWebSearchResultItem {
	type?: "web_search_result";
	title?: string;
	url?: string;
	page_age?: string;
	encrypted_content?: string;
}

export interface AnthropicWebSearchToolResult {
	type: "web_search_tool_result";
	tool_use_id?: string;
	content: AnthropicWebSearchResultItem[] | { type: "web_search_tool_result_error"; error_code?: string };
}

export interface AnthropicDocumentSource {
	type: "text" | "base64";
	media_type: string;
	data: string;
}

export interface AnthropicFetchedDocument {
	type: "document";
	source: AnthropicDocumentSource;
	title?: string;
	citations?: { enabled: boolean };
}

export interface AnthropicWebFetchResultSuccess {
	type: "web_fetch_result";
	url: string;
	retrieved_at?: string;
	content: AnthropicFetchedDocument;
}

export interface AnthropicWebFetchResultError {
	type: "web_fetch_tool_error";
	error_code: string;
}

export interface AnthropicWebFetchToolResult {
	type: "web_fetch_tool_result";
	tool_use_id?: string;
	content: AnthropicWebFetchResultSuccess | AnthropicWebFetchResultError;
}

export type AnthropicContentBlock =
	| AnthropicTextBlock
	| AnthropicThinkingBlock
	| AnthropicToolUseBlock
	| AnthropicWebSearchToolResult
	| { type: string; [key: string]: unknown };

export interface AnthropicUsage {
	input_tokens?: number;
	output_tokens?: number;
	cache_read_input_tokens?: number;
	cache_creation_input_tokens?: number;
	server_tool_use?: Record<string, number>;
}

export interface AnthropicMessage {
	id: string;
	type: "message";
	role: "assistant";
	model: string;
	content: AnthropicContentBlock[];
	stop_reason?: string | null;
	usage?: AnthropicUsage;
}

export interface AnthropicErrorBody {
	type: "error";
	error: {
		type: string;
		message: string;
	};
}

export type AnthropicResponse =
	| { ok: true; status: number; message: AnthropicMessage; rawText: string; headers: Headers }
	| {
		ok: false;
		status: number;
		errorType: string;
		errorMessage: string;
		category: AnthropicErrorCategory;
		rawText: string;
		headers: Headers;
	};

export type AnthropicErrorCategory =
	| "geo_restriction"
	| "rate_limit"
	| "position_zero_gate"
	| "classifier_third_party"
	| "model_not_found"
	| "auth_failed"
	| "bad_request"
	| "server_error"
	| "unknown";

export interface MessagesRequestOptions {
	bearer: string;
	model: string;
	maxTokens: number;
	systemText?: string;
	messages: Array<{ role: "user" | "assistant"; content: string | unknown[] }>;
	tools?: unknown[];
	thinking?: { type: "enabled"; budget_tokens: number };
	signal?: AbortSignal;
}

export function buildHeaders(bearer: string): Record<string, string> {
	return {
		Authorization: `Bearer ${bearer}`,
		"anthropic-beta": ANTHROPIC_BETA_HEADER,
		"anthropic-version": ANTHROPIC_VERSION_HEADER,
		"content-type": "application/json",
	};
}

export function buildRequestBody(opts: MessagesRequestOptions): Record<string, unknown> {
	const body: Record<string, unknown> = {
		model: opts.model,
		max_tokens: opts.maxTokens,
		system: [{ type: "text", text: opts.systemText ?? PREAMBLE }],
		messages: opts.messages,
	};
	if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
	if (opts.thinking) body.thinking = opts.thinking;
	return body;
}

function categorizeError(status: number, errorType: string, errorMessage: string): AnthropicErrorCategory {
	const lowerMsg = errorMessage.toLowerCase();
	if (status === 401) return "auth_failed";
	if (errorType === "not_found_error" || /^model:/i.test(errorMessage)) return "model_not_found";
	if (lowerMsg.includes("geo") || lowerMsg.includes("region") || lowerMsg.includes("united states")) {
		return "geo_restriction";
	}
	if (/third-party apps/i.test(errorMessage)) return "classifier_third_party";
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server_error";
	if (status >= 400) return "bad_request";
	return "unknown";
}

export async function callMessages(opts: MessagesRequestOptions): Promise<AnthropicResponse> {
	const body = buildRequestBody(opts);

	const res = await fetch(ANTHROPIC_API_URL, {
		method: "POST",
		signal: opts.signal,
		headers: buildHeaders(opts.bearer),
		body: JSON.stringify(body),
	});
	const rawText = await res.text();

	if (!res.ok) {
		// Synthetic 429 with no anthropic-ratelimit-* headers means the
		// position-0 SDK preamble was rejected by Anthropic's OAuth auth-layer
		// gate, not real rate limiting. There is no retry-after to honor.
		if (res.status === 429 && !res.headers.get("anthropic-ratelimit-unified-5h-utilization")) {
			return {
				ok: false,
				status: res.status,
				errorType: "position_zero_gate",
				errorMessage: "Synthetic 429: position-0 SDK preamble was rejected by Anthropic's auth-layer gate.",
				category: "position_zero_gate",
				rawText,
				headers: res.headers,
			};
		}
		let errorType = "unknown";
		let errorMessage = rawText.slice(0, 400);
		try {
			const parsed = JSON.parse(rawText) as AnthropicErrorBody;
			if (parsed?.error) {
				errorType = parsed.error.type ?? "unknown";
				errorMessage = parsed.error.message ?? errorMessage;
			}
		} catch {
			// keep raw
		}
		return {
			ok: false,
			status: res.status,
			errorType,
			errorMessage,
			category: categorizeError(res.status, errorType, errorMessage),
			rawText,
			headers: res.headers,
		};
	}

	try {
		const parsed = JSON.parse(rawText) as AnthropicMessage;
		return { ok: true, status: res.status, message: parsed, rawText, headers: res.headers };
	} catch (err) {
		return {
			ok: false,
			status: res.status,
			errorType: "parse_error",
			errorMessage: `Failed to parse response body: ${err instanceof Error ? err.message : String(err)}`,
			category: "unknown",
			rawText,
			headers: res.headers,
		};
	}
}

/**
 * Pull all text blocks from an Anthropic message, concatenated.
 */
export function joinTextBlocks(message: AnthropicMessage): string {
	const parts: string[] = [];
	for (const block of message.content) {
		if (block.type === "text" && typeof (block as AnthropicTextBlock).text === "string") {
			parts.push((block as AnthropicTextBlock).text);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Find the first thinking-related block; the actual text is redacted for OAuth.
 * We return whether it fired and any signature length for diagnostics.
 */
export function summarizeThinking(message: AnthropicMessage): {
	fired: boolean;
	signatureChars: number;
} {
	for (const block of message.content) {
		if (block.type === "thinking" || block.type === "redacted_thinking") {
			const sig = (block as AnthropicThinkingBlock).signature ?? (block as AnthropicThinkingBlock).data ?? "";
			return { fired: true, signatureChars: sig.length };
		}
	}
	return { fired: false, signatureChars: 0 };
}

/**
 * Pull web_search_tool_result blocks out of a message.
 */
export function extractWebSearchResults(message: AnthropicMessage): {
	results: AnthropicWebSearchResultItem[];
	errorCode?: string;
} {
	for (const block of message.content) {
		if (block.type !== "web_search_tool_result") continue;
		const wb = block as AnthropicWebSearchToolResult;
		if (Array.isArray(wb.content)) {
			return { results: wb.content as AnthropicWebSearchResultItem[] };
		}
		if (wb.content && typeof wb.content === "object" && "type" in wb.content) {
			return {
				results: [],
				errorCode: (wb.content as { error_code?: string }).error_code,
			};
		}
	}
	return { results: [] };
}

/**
 * Pull the (single) web_search_tool_use + web_search_tool_result pair
 * out of a message, in the original block order. Used by web_search to
 * record the prior assistant turn into the citation-context cache so
 * subsequent server-mode web_fetch calls can replay it for citation
 * linkage. Returns undefined if the pair isn't fully present.
 */
export function extractSearchAssistantBlocks(
	message: AnthropicMessage,
): AnthropicContentBlock[] | undefined {
	const kept: AnthropicContentBlock[] = [];
	for (const block of message.content) {
		if (block.type === "server_tool_use" && (block as AnthropicToolUseBlock).name === "web_search") {
			kept.push(block);
		} else if (block.type === "web_search_tool_result") {
			kept.push(block);
		}
	}
	const hasUse = kept.some((b) => b.type === "server_tool_use");
	const hasResult = kept.some((b) => b.type === "web_search_tool_result");
	return hasUse && hasResult ? kept : undefined;
}

/**
 * Pull the single web_fetch_tool_result block out of a server-mode
 * fetch response. Server-side web_fetch is invoked with max_uses=1 so
 * a well-formed response carries exactly one such block.
 */
export function extractWebFetchResult(
	message: AnthropicMessage,
): AnthropicWebFetchResultSuccess | AnthropicWebFetchResultError | undefined {
	for (const block of message.content) {
		if (block.type !== "web_fetch_tool_result") continue;
		const wb = block as unknown as AnthropicWebFetchToolResult;
		if (wb.content && typeof wb.content === "object") return wb.content;
	}
	return undefined;
}

/**
 * Decode a fetched document's source into a uniform shape:
 *   - text/plain (or other text/*) → raw string
 *   - application/pdf base64       → binary length + indicator string
 *   - anything else                → best-effort text decode
 */
export function decodeFetchedDocument(
	success: AnthropicWebFetchResultSuccess,
): { text: string; isPdf: boolean; byteLength: number } {
	const src = success.content?.source;
	if (!src) return { text: "", isPdf: false, byteLength: 0 };
	if (src.type === "text") {
		return {
			text: typeof src.data === "string" ? src.data : "",
			isPdf: false,
			byteLength: typeof src.data === "string" ? Buffer.byteLength(src.data, "utf8") : 0,
		};
	}
	if (src.type === "base64") {
		const buf = Buffer.from(src.data ?? "", "base64");
		const isPdf = (src.media_type ?? "").toLowerCase() === "application/pdf";
		return {
			text: isPdf
				? `[PDF document, ${buf.byteLength} bytes; Anthropic has already extracted its text into the orchestrator's context]`
				: buf.toString("utf8"),
			isPdf,
			byteLength: buf.byteLength,
		};
	}
	return { text: "", isPdf: false, byteLength: 0 };
}

/**
 * Map a server-side fetch `error_code` to a human-friendly message and
 * recoverable flag. Codes are documented at
 * platform.claude.com/docs/.../web-fetch-tool.
 */
export function mapServerFetchErrorCode(code: string): { message: string; recoverable: boolean } {
	switch (code) {
		case "invalid_input":
			return { message: "Anthropic rejected the URL as invalid input.", recoverable: false };
		case "url_too_long":
			return {
				message: "URL exceeds Anthropic's 250-character limit for server-side fetch.",
				recoverable: false,
			};
		case "url_not_allowed":
			return {
				message: "Anthropic refused the URL (blocked domain or policy).",
				recoverable: false,
			};
		case "url_not_accessible":
			return {
				message: "Anthropic could not reach the URL (DNS, 404, or origin error).",
				recoverable: true,
			};
		case "too_many_requests":
			return {
				message: "Anthropic rate-limited the server-side fetch; retry later.",
				recoverable: true,
			};
		case "unsupported_content_type":
			return {
				message: "Anthropic does not support this content type for server-side fetch.",
				recoverable: false,
			};
		case "max_uses_exceeded":
			return {
				message: "Server-side fetch max_uses cap exceeded (pi-web sets this to 1 per call).",
				recoverable: false,
			};
		case "unavailable":
			return {
				message: "Anthropic's server-side fetch is temporarily unavailable.",
				recoverable: true,
			};
		default:
			return { message: `Server-side fetch error: ${code}.`, recoverable: false };
	}
}
