/**
 * In-memory store of "this URL came from this prior web_search turn".
 *
 * Server-side `web_fetch` (backend: "server") needs the original
 * web_search assistant turn replayed into the /v1/messages body to get
 * citation linkage. Anthropic's docs are explicit: there is no per-call
 * encrypted token on web_fetch; provenance is conversation-history based.
 *
 * This cache is deliberately separate from the tool-result cache:
 *   - Different value shape (Anthropic message blocks, not pi-web's
 *     {content, details}).
 *   - Never persisted to disk; the embedded `encrypted_content` blobs
 *     are Anthropic-internal tokens we don't want sitting on disk.
 *   - Same TTL as the tool-result cache so a search cached for 15
 *     minutes carries citation eligibility for the same 15 minutes.
 */

export interface AssistantTurnBlock {
	type: string;
	[key: string]: unknown;
}

export interface CitationContextEntry {
	url: string;
	query: string;
	assistantBlocks: AssistantTurnBlock[];
	expiresAt: number;
}

export interface CitationContextOptions {
	ttlSeconds: number;
	maxEntries: number;
	now?: () => number;
}

export class CitationContextCache {
	private store = new Map<string, CitationContextEntry>();
	private opts: CitationContextOptions;

	constructor(opts: CitationContextOptions) {
		this.opts = opts;
	}

	updateOptions(patch: Partial<CitationContextOptions>): void {
		this.opts = { ...this.opts, ...patch };
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	/**
	 * Record that a URL came from a given web_search turn. The same
	 * assistant turn is shared across all URLs in a single search; we
	 * store it once per URL so later lookups don't need to scan.
	 */
	record(args: {
		urls: readonly string[];
		query: string;
		assistantBlocks: AssistantTurnBlock[];
	}): void {
		const expiresAt = this.now() + this.opts.ttlSeconds * 1000;
		for (const rawUrl of args.urls) {
			const url = normalizeUrl(rawUrl);
			if (!url) continue;
			this.store.delete(url);
			this.store.set(url, {
				url,
				query: args.query,
				assistantBlocks: args.assistantBlocks,
				expiresAt,
			});
		}
		this.evictIfNeeded();
	}

	get(rawUrl: string): CitationContextEntry | undefined {
		const url = normalizeUrl(rawUrl);
		if (!url) return undefined;
		const entry = this.store.get(url);
		if (!entry) return undefined;
		if (entry.expiresAt <= this.now()) {
			this.store.delete(url);
			return undefined;
		}
		this.store.delete(url);
		this.store.set(url, entry);
		return entry;
	}

	has(rawUrl: string): boolean {
		return !!this.get(rawUrl);
	}

	clear(): void {
		this.store.clear();
	}

	size(): number {
		return this.store.size;
	}

	private evictIfNeeded(): void {
		while (this.store.size > this.opts.maxEntries) {
			const oldest = this.store.keys().next().value;
			if (oldest === undefined) break;
			this.store.delete(oldest);
		}
	}
}

/**
 * Light URL canonicalisation so trailing-slash / case-of-host variants
 * hit the same citation entry. We do not strip query strings or
 * fragments \u2014 those identify distinct pages in the eyes of a user.
 */
export function normalizeUrl(raw: string): string | undefined {
	if (typeof raw !== "string" || raw.length === 0) return undefined;
	try {
		const u = new URL(raw);
		u.hostname = u.hostname.toLowerCase();
		// Drop a single trailing slash on the path only when the path is
		// non-root \u2014 "/foo/" and "/foo" are routinely treated as the
		// same resource by web servers.
		if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
			u.pathname = u.pathname.slice(0, -1);
		}
		return u.toString();
	} catch {
		return undefined;
	}
}
