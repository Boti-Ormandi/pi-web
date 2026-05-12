import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCacheBackend } from "../src/cache/disk.js";
import { makeFetchCacheKey, makeSearchCacheKey, MemoryCache } from "../src/cache/store.js";

describe("MemoryCache", () => {
	it("returns undefined on miss", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		expect(c.get("nope")).toBeUndefined();
	});

	it("get-after-set works", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		c.set("k", "v");
		expect(c.get("k")).toBe("v");
	});

	it("respects TTL", () => {
		let now = 1000;
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 1, maxEntries: 10, now: () => now });
		c.set("k", "v");
		expect(c.get("k")).toBe("v");
		now += 2000;
		expect(c.get("k")).toBeUndefined();
	});

	it("evicts oldest beyond max_entries", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 2 });
		c.set("a", "1");
		c.set("b", "2");
		c.set("c", "3");
		expect(c.get("a")).toBeUndefined();
		expect(c.get("b")).toBe("2");
		expect(c.get("c")).toBe("3");
	});

	it("LRU touch on get moves entry to most-recent", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 2 });
		c.set("a", "1");
		c.set("b", "2");
		// Touch a; b becomes oldest.
		c.get("a");
		c.set("c", "3");
		expect(c.get("a")).toBe("1");
		expect(c.get("b")).toBeUndefined();
	});

	it("disabling clears entries", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		c.set("a", "1");
		c.updateOptions({ enabled: false });
		expect(c.get("a")).toBeUndefined();
	});

	it("hits/misses counters update", () => {
		const c = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		c.set("a", "1");
		c.get("a");
		c.get("b");
		const stats = c.getStats();
		expect(stats.hits).toBe(1);
		expect(stats.misses).toBe(1);
	});
});

describe("cache key builders", () => {
	it("search key is stable across array order", () => {
		const k1 = makeSearchCacheKey({
			query: "q",
			maxResults: 10,
			allowedDomains: ["a.com", "b.com"],
			blockedDomains: ["c.com"],
			model: "anthropic/claude-haiku-4-5",
		});
		const k2 = makeSearchCacheKey({
			query: "q",
			maxResults: 10,
			allowedDomains: ["b.com", "a.com"],
			blockedDomains: ["c.com"],
			model: "anthropic/claude-haiku-4-5",
		});
		expect(k1).toBe(k2);
	});

	it("fetch key changes with prompt", () => {
		const a = makeFetchCacheKey({ url: "https://x", mode: "summary", prompt: "p1" });
		const b = makeFetchCacheKey({ url: "https://x", mode: "summary", prompt: "p2" });
		expect(a).not.toBe(b);
	});

	it("fetch key changes with mode", () => {
		const a = makeFetchCacheKey({ url: "https://x", mode: "raw" });
		const b = makeFetchCacheKey({ url: "https://x", mode: "summary" });
		expect(a).not.toBe(b);
	});
});

describe("DiskCacheBackend", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-web-disk-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("persists set entries to disk and restores them into a fresh cache", () => {
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("k1", "v1");
		cache.set("k2", "v2");
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(2);

		const fresh = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		const disk2 = new DiskCacheBackend<string>({ dir });
		const { restored, expired } = fresh.restore(disk2.loadAll());
		expect(restored).toBe(2);
		expect(expired).toBe(0);
		expect(fresh.get("k1")).toBe("v1");
		expect(fresh.get("k2")).toBe("v2");
	});

	it("drops expired entries on restore and leaves their files on disk", () => {
		let now = 1_000_000;
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 1, maxEntries: 10, now: () => now });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("k1", "v1");
		now += 5000;

		const fresh = new MemoryCache<string>({ enabled: true, ttlSeconds: 1, maxEntries: 10, now: () => now });
		const { restored, expired } = fresh.restore(disk.loadAll());
		expect(restored).toBe(0);
		expect(expired).toBe(1);
		expect(fresh.get("k1")).toBeUndefined();
	});

	it("delete removes the file", () => {
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("k1", "v1");
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(1);
		cache.delete("k1");
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(0);
	});

	it("clear removes all files", () => {
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("k1", "v1");
		cache.set("k2", "v2");
		cache.clear();
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(0);
	});

	it("eviction also deletes the corresponding file", () => {
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 2 });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("a", "1");
		cache.set("b", "2");
		cache.set("c", "3");
		// One of the three was evicted; only two files remain.
		expect(readdirSync(dir).filter((f) => f.endsWith(".json")).length).toBe(2);
	});

	it("loadAll ignores corrupt files", () => {
		const cache = new MemoryCache<string>({ enabled: true, ttlSeconds: 60, maxEntries: 10 });
		const disk = new DiskCacheBackend<string>({ dir });
		cache.setPersistence(disk.toHook());
		cache.set("k1", "v1");
		writeFileSync(join(dir, "junk.json"), "not json", "utf8");
		const entries = disk.loadAll();
		expect(entries.find((e) => e.key === "k1")?.value).toBe("v1");
		expect(entries.length).toBe(1);
	});
});
