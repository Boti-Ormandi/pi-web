import { describe, expect, it } from "vitest";
import { CitationContextCache, normalizeUrl } from "../src/cache/citation-context.js";

function makeBlocks() {
	return [
		{ type: "server_tool_use", id: "x", name: "web_search", input: { query: "q" } },
		{
			type: "web_search_tool_result",
			tool_use_id: "x",
			content: [{ type: "web_search_result", url: "https://example.com/a", encrypted_content: "abc" }],
		},
	];
}

describe("CitationContextCache", () => {
	it("records and retrieves by URL", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["https://example.com/a", "https://example.com/b"], query: "rust", assistantBlocks: makeBlocks() });
		const e = c.get("https://example.com/a");
		expect(e?.query).toBe("rust");
		expect(e?.assistantBlocks).toHaveLength(2);
		expect(c.has("https://example.com/b")).toBe(true);
		expect(c.has("https://example.com/missing")).toBe(false);
	});

	it("expires entries after TTL", () => {
		let t = 1000;
		const c = new CitationContextCache({ ttlSeconds: 1, maxEntries: 100, now: () => t });
		c.record({ urls: ["https://example.com/a"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.has("https://example.com/a")).toBe(true);
		t = 1000 + 2000;
		expect(c.has("https://example.com/a")).toBe(false);
		expect(c.size()).toBe(0);
	});

	it("normalises trailing-slash and host-case variants", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["https://Example.COM/a/"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.has("https://example.com/a")).toBe(true);
		expect(c.has("https://EXAMPLE.com/a/")).toBe(true);
	});

	it("does not strip query strings or fragments", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["https://example.com/a?id=1"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.has("https://example.com/a?id=1")).toBe(true);
		expect(c.has("https://example.com/a")).toBe(false);
	});

	it("preserves root '/' path (no slash-strip on root)", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["https://example.com/"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.has("https://example.com/")).toBe(true);
	});

	it("evicts oldest entries when over capacity", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 2 });
		c.record({ urls: ["https://a.example/1"], query: "q", assistantBlocks: makeBlocks() });
		c.record({ urls: ["https://a.example/2"], query: "q", assistantBlocks: makeBlocks() });
		c.record({ urls: ["https://a.example/3"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.size()).toBe(2);
		expect(c.has("https://a.example/1")).toBe(false);
		expect(c.has("https://a.example/2")).toBe(true);
		expect(c.has("https://a.example/3")).toBe(true);
	});

	it("touch-on-get keeps recently-accessed entries from being evicted", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 2 });
		c.record({ urls: ["https://a.example/1"], query: "q", assistantBlocks: makeBlocks() });
		c.record({ urls: ["https://a.example/2"], query: "q", assistantBlocks: makeBlocks() });
		// Touch /1 to mark fresh.
		expect(c.get("https://a.example/1")).toBeDefined();
		c.record({ urls: ["https://a.example/3"], query: "q", assistantBlocks: makeBlocks() });
		expect(c.has("https://a.example/1")).toBe(true);
		expect(c.has("https://a.example/2")).toBe(false);
		expect(c.has("https://a.example/3")).toBe(true);
	});

	it("rejects malformed URLs silently", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["not a url", ""], query: "q", assistantBlocks: makeBlocks() });
		expect(c.size()).toBe(0);
		expect(c.has("not a url")).toBe(false);
	});

	it("clear() drops everything", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 100 });
		c.record({ urls: ["https://a.example/1"], query: "q", assistantBlocks: makeBlocks() });
		c.clear();
		expect(c.size()).toBe(0);
	});
});

describe("normalizeUrl", () => {
	it("lowers host case", () => {
		expect(normalizeUrl("https://EXAMPLE.com/a")).toBe("https://example.com/a");
	});

	it("returns undefined for non-URLs", () => {
		expect(normalizeUrl("")).toBeUndefined();
		expect(normalizeUrl("not a url")).toBeUndefined();
	});
});
