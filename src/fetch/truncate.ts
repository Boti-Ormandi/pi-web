/**
 * Rough token estimator. Closer-to-correct than `text.length / 4`
 * for english markdown after html extraction; not exact but adequate
 * for fit-to-context decisions.
 */
export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	const bytes = Buffer.byteLength(text, "utf8");
	return Math.ceil(bytes / 4);
}

export interface TruncationResult {
	text: string;
	originalChars: number;
	truncated: boolean;
	estimatedTokens: number;
}

/**
 * Truncate text by byte budget, keeping the head (where the article body lives).
 * Adds an explicit truncation marker for the consumer's prompt.
 */
export function truncateForTokens(text: string, maxTokens: number): TruncationResult {
	if (maxTokens <= 0) {
		return { text: "", originalChars: text.length, truncated: true, estimatedTokens: 0 };
	}
	const targetBytes = maxTokens * 4;
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= targetBytes) {
		return {
			text,
			originalChars: text.length,
			truncated: false,
			estimatedTokens: Math.ceil(buf.byteLength / 4),
		};
	}
	const slice = buf.subarray(0, targetBytes).toString("utf8");
	const safe = slice.slice(0, Math.max(0, slice.length - 32));
	return {
		text: safe,
		originalChars: text.length,
		truncated: true,
		estimatedTokens: Math.ceil(Buffer.byteLength(safe, "utf8") / 4),
	};
}

/**
 * Truncate text by raw byte budget, keeping the head.
 */
export function truncateByBytes(text: string, maxBytes: number): TruncationResult {
	if (maxBytes <= 0) {
		return { text: "", originalChars: text.length, truncated: true, estimatedTokens: 0 };
	}
	const buf = Buffer.from(text, "utf8");
	if (buf.byteLength <= maxBytes) {
		return {
			text,
			originalChars: text.length,
			truncated: false,
			estimatedTokens: Math.ceil(buf.byteLength / 4),
		};
	}
	const slice = buf.subarray(0, maxBytes).toString("utf8");
	const safe = slice.slice(0, Math.max(0, slice.length - 16));
	return {
		text: safe,
		originalChars: text.length,
		truncated: true,
		estimatedTokens: Math.ceil(Buffer.byteLength(safe, "utf8") / 4),
	};
}
