import {
	completeSimple,
	type AssistantMessage,
	type Context,
	type Model,
	type Api,
	type SimpleStreamOptions,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";

/**
 * Bridge to non-Anthropic providers via pi-ai's `completeSimple`. The
 * Anthropic path stays on our hand-rolled `/v1/messages` helper because we
 * depend on its position-0 SDK preamble and oauth beta header to satisfy
 * Anthropic's auth-layer gate. For OpenAI / Google / Bedrock / etc. we
 * have no such constraint; pi-ai already speaks every provider pi can
 * authenticate to.
 *
 * Only `web_fetch summary` mode reaches this code path. `web_search` stays
 * Anthropic-only end-to-end (it depends on Anthropic's server-side
 * `web_search` tool, which no other provider exposes).
 */
export interface SummarizeProviderRequest {
	model: Model<Api>;
	/** Resolved API key from `ctx.modelRegistry.getApiKeyAndHeaders(model)`. */
	apiKey: string | undefined;
	/** Resolved extra headers from `ctx.modelRegistry.getApiKeyAndHeaders(model)`. */
	headers: Record<string, string> | undefined;
	systemText: string;
	userText: string;
	answerMaxTokens: number;
	thinkingBudget?: number | undefined;
	signal?: AbortSignal | undefined;
}

export type SummarizeProviderResult =
	| {
			ok: true;
			text: string;
			thinkingFired: boolean;
			thinkingSignatureChars: number;
			usage: { input_tokens?: number; output_tokens?: number };
			cost: number | undefined;
	  }
	| {
			ok: false;
			reason: string;
			recoverable: boolean;
	  };

export function thinkingBudgetToLevel(budget: number | undefined): ThinkingLevel | undefined {
	if (!budget || budget < 1024) return undefined;
	if (budget < 4000) return "low";
	if (budget < 8000) return "medium";
	if (budget < 16000) return "high";
	return "xhigh";
}

export async function summarizeViaPiAi(req: SummarizeProviderRequest): Promise<SummarizeProviderResult> {
	const context: Context = {
		systemPrompt: req.systemText,
		messages: [
			{
				role: "user",
				content: req.userText,
				timestamp: Date.now(),
			},
		],
	};

	const options: SimpleStreamOptions = {
		maxTokens: req.answerMaxTokens,
		signal: req.signal,
	};
	if (req.apiKey) options.apiKey = req.apiKey;
	if (req.headers) options.headers = req.headers;

	const level = thinkingBudgetToLevel(req.thinkingBudget);
	if (level && req.model.reasoning) {
		options.reasoning = level;
		if (typeof req.thinkingBudget === "number") {
			options.thinkingBudgets = {
				low: Math.max(1024, Math.min(4000, req.thinkingBudget)),
				medium: Math.max(1024, Math.min(8000, req.thinkingBudget)),
				high: Math.max(1024, Math.min(16000, req.thinkingBudget)),
			};
		}
	}

	let message: AssistantMessage;
	try {
		message = await completeSimple(req.model, context, options);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		const lower = msg.toLowerCase();
		const recoverable = !/auth|unauthor|forbidden|invalid api key|no api key/.test(lower);
		return { ok: false, reason: msg, recoverable };
	}

	if (message.stopReason === "error") {
		return {
			ok: false,
			reason: message.errorMessage ?? "Provider returned an error stop reason.",
			recoverable: true,
		};
	}
	if (message.stopReason === "aborted") {
		return { ok: false, reason: "Aborted by user.", recoverable: true };
	}

	let text = "";
	let thinkingFired = false;
	let thinkingSignatureChars = 0;
	for (const block of message.content) {
		if (block.type === "text") text += (text ? "\n" : "") + block.text;
		else if (block.type === "thinking") {
			thinkingFired = true;
			thinkingSignatureChars = Math.max(
				thinkingSignatureChars,
				typeof block.thinkingSignature === "string" ? block.thinkingSignature.length : 0,
			);
		}
	}

	return {
		ok: true,
		text: text.trim(),
		thinkingFired,
		thinkingSignatureChars,
		usage: {
			input_tokens: message.usage?.input,
			output_tokens: message.usage?.output,
		},
		cost: message.usage?.cost?.total,
	};
}
