import { stableHash } from "../util/hash.js";

export interface CacheEntry<T> {
	key: string;
	createdAt: number;
	expiresAt: number;
	value: T;
	sizeBytes: number;
	tag: string;
}

export interface CacheStats {
	entries: number;
	hits: number;
	misses: number;
	evictions: number;
	bytes: number;
}

export interface CacheOptions {
	enabled: boolean;
	ttlSeconds: number;
	maxEntries: number;
	now?: () => number;
}

/**
 * Hooks invoked by MemoryCache on every mutation so an external store
 * (disk, etc.) can mirror the in-memory state. All hooks are best-effort:
 * the cache never throws if a hook throws — failures are surfaced via
 * the optional `onError` callback the integrator wires up.
 */
export interface CachePersistenceHook<T> {
	onSet(entry: CacheEntry<T>): void;
	onDelete(key: string): void;
	onClear(): void;
}

/**
 * Simple LRU + TTL cache. Single-process, in-memory.
 *
 * We use `Map` insertion-order ordering: get() deletes-and-reinserts to
 * mark the entry "fresh" for LRU. Eviction removes the oldest entry
 * (first iterator value) when over capacity.
 */
export class MemoryCache<T> {
	private store = new Map<string, CacheEntry<T>>();
	private stats: CacheStats = { entries: 0, hits: 0, misses: 0, evictions: 0, bytes: 0 };
	private opts: CacheOptions;
	private persistence: CachePersistenceHook<T> | undefined;

	constructor(opts: CacheOptions) {
		this.opts = opts;
	}

	setPersistence(hook: CachePersistenceHook<T> | undefined): void {
		this.persistence = hook;
	}

	private now(): number {
		return (this.opts.now ?? Date.now)();
	}

	updateOptions(patch: Partial<CacheOptions>): void {
		this.opts = { ...this.opts, ...patch };
		if (!this.opts.enabled) this.clear();
	}

	/**
	 * Repopulate the cache from a previously-persisted set of entries (e.g.
	 * on startup from disk). Skips expired entries. Bypasses the persistence
	 * hook to avoid round-trip writes during load.
	 */
	restore(entries: Iterable<CacheEntry<T>>): { restored: number; expired: number } {
		let restored = 0;
		let expired = 0;
		const now = this.now();
		for (const e of entries) {
			if (e.expiresAt <= now) {
				expired++;
				continue;
			}
			this.store.delete(e.key);
			this.store.set(e.key, { ...e });
			this.stats.bytes += e.sizeBytes;
			restored++;
		}
		this.stats.entries = this.store.size;
		// If restore pushed us past capacity, evict — those evictions DO get
		// persisted (deleted from disk) so the stale records don't linger.
		this.evictIfNeeded();
		return { restored, expired };
	}

	get(key: string): T | undefined {
		if (!this.opts.enabled) return undefined;
		const entry = this.store.get(key);
		if (!entry) {
			this.stats.misses++;
			return undefined;
		}
		if (entry.expiresAt <= this.now()) {
			this.store.delete(key);
			this.stats.entries = this.store.size;
			this.stats.bytes -= entry.sizeBytes;
			this.stats.misses++;
			return undefined;
		}
		// LRU touch.
		this.store.delete(key);
		this.store.set(key, entry);
		this.stats.hits++;
		return entry.value;
	}

	set(key: string, value: T, opts?: { sizeBytes?: number; tag?: string; ttlSeconds?: number }): void {
		if (!this.opts.enabled) return;
		const ttl = opts?.ttlSeconds ?? this.opts.ttlSeconds;
		const sizeBytes = opts?.sizeBytes ?? estimateSizeBytes(value);
		const tag = opts?.tag ?? "";
		const now = this.now();
		const existing = this.store.get(key);
		if (existing) {
			this.stats.bytes -= existing.sizeBytes;
		}
		this.store.delete(key);
		const entry: CacheEntry<T> = {
			key,
			createdAt: now,
			expiresAt: now + ttl * 1000,
			value,
			sizeBytes,
			tag,
		};
		this.store.set(key, entry);
		this.stats.bytes += sizeBytes;
		this.stats.entries = this.store.size;
		this.notifyPersistence(() => this.persistence?.onSet(entry));
		this.evictIfNeeded();
	}

	clear(): void {
		this.store.clear();
		this.stats.entries = 0;
		this.stats.bytes = 0;
		this.notifyPersistence(() => this.persistence?.onClear());
	}

	delete(key: string): boolean {
		const entry = this.store.get(key);
		if (!entry) return false;
		this.store.delete(key);
		this.stats.bytes -= entry.sizeBytes;
		this.stats.entries = this.store.size;
		this.notifyPersistence(() => this.persistence?.onDelete(key));
		return true;
	}

	entries(): CacheEntry<T>[] {
		return Array.from(this.store.values());
	}

	getStats(): CacheStats {
		return { ...this.stats };
	}

	private evictIfNeeded(): void {
		while (this.store.size > this.opts.maxEntries) {
			const oldestKey = this.store.keys().next().value;
			if (oldestKey === undefined) break;
			const entry = this.store.get(oldestKey);
			this.store.delete(oldestKey);
			if (entry) this.stats.bytes -= entry.sizeBytes;
			this.stats.evictions++;
			this.notifyPersistence(() => this.persistence?.onDelete(oldestKey));
		}
		this.stats.entries = this.store.size;
	}

	private notifyPersistence(fn: () => void): void {
		try {
			fn();
		} catch {
			// Persistence is best-effort; the disk backend is responsible for
			// surfacing failures via its own error channel.
		}
	}
}

function estimateSizeBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return 0;
	}
}

export function makeSearchCacheKey(input: {
	query: string;
	maxResults: number;
	allowedDomains: readonly string[];
	blockedDomains: readonly string[];
	model: string;
}): string {
	return (
		"search:v1:" +
		stableHash({
			query: input.query,
			max: input.maxResults,
			allow: [...input.allowedDomains].sort(),
			block: [...input.blockedDomains].sort(),
			model: input.model,
		})
	);
}

export function makeFetchCacheKey(input: {
	url: string;
	mode: string;
	prompt?: string;
	model?: string;
	thinkingBudget?: number | null;
	rawMaxBytes?: number;
	backend?: string;
	maxContentTokens?: number;
}): string {
	return (
		"fetch:v1:" +
		stableHash({
			url: input.url,
			mode: input.mode,
			prompt: input.prompt ?? "",
			model: input.model ?? "",
			thinking: input.thinkingBudget ?? 0,
			rawMax: input.rawMaxBytes ?? 0,
			backend: input.backend ?? "client",
			maxContent: input.maxContentTokens ?? 0,
		})
	);
}
