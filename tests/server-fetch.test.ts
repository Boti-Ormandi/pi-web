import { describe, expect, it } from "vitest";
import { CitationContextCache } from "../src/cache/citation-context.js";
import { buildServerFetchMessages } from "../src/tools/web-fetch.js";

function recordCitation(c: CitationContextCache, url: string, query: string) {
	c.record({
		urls: [url],
		query,
		assistantBlocks: [
			{ type: "server_tool_use", id: "u1", name: "web_search", input: { query } },
			{
				type: "web_search_tool_result",
				tool_use_id: "u1",
				content: [{ type: "web_search_result", url, encrypted_content: "blob" }],
			},
		],
	});
}

describe("buildServerFetchMessages", () => {
	it("returns a single user message when no citation context is available", () => {
		const out = buildServerFetchMessages({
			url: "https://example.com/article",
			prompt: "What are the top 3 features?",
			citation: undefined,
		});
		expect(out).toHaveLength(1);
		const m0 = out[0]!;
		expect(m0.role).toBe("user");
		expect(typeof m0.content).toBe("string");
		const text = m0.content as string;
		expect(text).toContain("https://example.com/article");
		expect(text).toContain("What are the top 3 features?");
	});

	it("uses imperative wording to discourage the orchestrator from skipping web_fetch", () => {
		const out = buildServerFetchMessages({
			url: "https://example.com/article",
			prompt: "What does the page say?",
			citation: undefined,
		});
		const text = out[0]!.content as string;
		expect(text).toContain("Use your web_fetch tool");
		expect(text).toContain("Do not answer from prior knowledge");
	});

	it("uses imperative wording in the follow-up user message when citation context is replayed", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 10 });
		recordCitation(c, "https://example.com/article", "rust ownership");
		const out = buildServerFetchMessages({
			url: "https://example.com/article",
			prompt: "What does the page say?",
			citation: c.get("https://example.com/article"),
		});
		const followUp = out[2]!.content as string;
		expect(followUp).toContain("Use your web_fetch tool");
		expect(followUp).toContain("Do not answer from prior knowledge");
	});

	it("uses a default prompt when none is provided", () => {
		const out = buildServerFetchMessages({
			url: "https://example.com/page",
			prompt: undefined,
			citation: undefined,
		});
		const text = out[0]!.content as string;
		expect(text).toContain("Return the page content");
	});

	it("replays the prior search turn when citation context is present", () => {
		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 10 });
		recordCitation(c, "https://example.com/article", "rust ownership");
		const citation = c.get("https://example.com/article");
		expect(citation).toBeDefined();

		const out = buildServerFetchMessages({
			url: "https://example.com/article",
			prompt: "Summarise the borrow checker section",
			citation,
		});
		expect(out).toHaveLength(3);
		const [m0, m1, m2] = [out[0]!, out[1]!, out[2]!];
		expect(m0.role).toBe("user");
		expect(m0.content).toContain("rust ownership");
		expect(m1.role).toBe("assistant");
		expect(Array.isArray(m1.content)).toBe(true);
		const assistantBlocks = m1.content as unknown[];
		expect(assistantBlocks).toHaveLength(2);
		expect((assistantBlocks[0] as { type: string }).type).toBe("server_tool_use");
		expect((assistantBlocks[1] as { type: string }).type).toBe("web_search_tool_result");
		expect(m2.role).toBe("user");
		expect(m2.content).toContain("https://example.com/article");
		expect(m2.content).toContain("Summarise the borrow checker section");
		expect(m2.content).toContain("search results above for context");
	});

	it("URL appears in the final user message regardless of citation status", () => {
		// Anthropic's docs require the URL to have appeared in conversation
		// context. The "no citation" path puts it in the user message; the
		// "with citation" path puts it in the assistant turn AND the
		// follow-up user message. Both paths exercise it; assert both.
		const url = "https://example.com/needle";
		const noCite = buildServerFetchMessages({ url, prompt: "x", citation: undefined });
		expect(noCite[0]!.content).toContain(url);

		const c = new CitationContextCache({ ttlSeconds: 60, maxEntries: 10 });
		recordCitation(c, url, "needle search");
		const withCite = buildServerFetchMessages({ url, prompt: "x", citation: c.get(url) });
		// The URL is in the assistant turn's web_search_tool_result AND the
		// follow-up user message. Check the user follow-up specifically.
		expect(withCite[2]!.content).toContain(url);
	});
});
