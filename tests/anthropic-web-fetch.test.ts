import { describe, expect, it } from "vitest";
import {
	decodeFetchedDocument,
	extractSearchAssistantBlocks,
	extractWebFetchResult,
	mapServerFetchErrorCode,
	type AnthropicMessage,
	type AnthropicWebFetchResultSuccess,
} from "../src/auth/anthropic.js";

function msg(content: unknown[]): AnthropicMessage {
	return {
		id: "msg_x",
		type: "message",
		role: "assistant",
		model: "claude-sonnet-4-6",
		content: content as AnthropicMessage["content"],
	};
}

describe("extractWebFetchResult", () => {
	it("returns the success result content", () => {
		const m = msg([
			{
				type: "web_fetch_tool_result",
				tool_use_id: "srvtoolu_1",
				content: {
					type: "web_fetch_result",
					url: "https://example.com/article",
					retrieved_at: "2025-08-25T10:30:00Z",
					content: {
						type: "document",
						source: { type: "text", media_type: "text/plain", data: "Hello world." },
						title: "Hello",
						citations: { enabled: true },
					},
				},
			},
		]);
		const r = extractWebFetchResult(m);
		expect(r).toBeDefined();
		expect(r?.type).toBe("web_fetch_result");
		if (r?.type === "web_fetch_result") {
			expect(r.url).toBe("https://example.com/article");
			expect(r.content.source.data).toBe("Hello world.");
		}
	});

	it("returns the error result content", () => {
		const m = msg([
			{
				type: "web_fetch_tool_result",
				tool_use_id: "srvtoolu_2",
				content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" },
			},
		]);
		const r = extractWebFetchResult(m);
		expect(r?.type).toBe("web_fetch_tool_error");
		if (r?.type === "web_fetch_tool_error") {
			expect(r.error_code).toBe("url_not_accessible");
		}
	});

	it("returns undefined when no web_fetch_tool_result block is present", () => {
		const m = msg([{ type: "text", text: "no tool was used" }]);
		expect(extractWebFetchResult(m)).toBeUndefined();
	});

	it("ignores unrelated tool_result blocks", () => {
		const m = msg([
			{ type: "web_search_tool_result", tool_use_id: "x", content: [] },
			{ type: "text", text: "hi" },
		]);
		expect(extractWebFetchResult(m)).toBeUndefined();
	});
});

describe("decodeFetchedDocument", () => {
	it("decodes text/plain into its raw string", () => {
		const r: AnthropicWebFetchResultSuccess = {
			type: "web_fetch_result",
			url: "https://example.com/x",
			content: {
				type: "document",
				source: { type: "text", media_type: "text/plain", data: "alpha beta gamma" },
			},
		};
		const d = decodeFetchedDocument(r);
		expect(d.text).toBe("alpha beta gamma");
		expect(d.isPdf).toBe(false);
		expect(d.byteLength).toBe(16);
	});

	it("decodes base64 PDFs into a stub with byte length", () => {
		const pdfBytes = Buffer.from("%PDF-1.4\n%fake", "utf8");
		const r: AnthropicWebFetchResultSuccess = {
			type: "web_fetch_result",
			url: "https://example.com/x.pdf",
			content: {
				type: "document",
				source: { type: "base64", media_type: "application/pdf", data: pdfBytes.toString("base64") },
			},
		};
		const d = decodeFetchedDocument(r);
		expect(d.isPdf).toBe(true);
		expect(d.byteLength).toBe(pdfBytes.length);
		expect(d.text).toContain("PDF document");
		expect(d.text).toContain(String(pdfBytes.length));
	});

	it("falls back to utf-8 decode for non-pdf base64", () => {
		const r: AnthropicWebFetchResultSuccess = {
			type: "web_fetch_result",
			url: "https://example.com/x",
			content: {
				type: "document",
				source: { type: "base64", media_type: "text/plain", data: Buffer.from("hi", "utf8").toString("base64") },
			},
		};
		const d = decodeFetchedDocument(r);
		expect(d.text).toBe("hi");
		expect(d.isPdf).toBe(false);
	});

	it("returns empty result for missing source", () => {
		const r = { type: "web_fetch_result", url: "x", content: { type: "document" } } as unknown as AnthropicWebFetchResultSuccess;
		const d = decodeFetchedDocument(r);
		expect(d.text).toBe("");
		expect(d.byteLength).toBe(0);
	});
});

describe("mapServerFetchErrorCode", () => {
	it("maps known codes to user-facing messages", () => {
		expect(mapServerFetchErrorCode("url_not_accessible").recoverable).toBe(true);
		expect(mapServerFetchErrorCode("url_too_long").recoverable).toBe(false);
		expect(mapServerFetchErrorCode("too_many_requests").recoverable).toBe(true);
		expect(mapServerFetchErrorCode("max_uses_exceeded").recoverable).toBe(false);
	});

	it("returns a fallback for unknown codes", () => {
		const r = mapServerFetchErrorCode("invented_code");
		expect(r.message).toContain("invented_code");
		expect(r.recoverable).toBe(false);
	});
});

describe("extractSearchAssistantBlocks", () => {
	it("returns the server_tool_use + web_search_tool_result pair in order", () => {
		const m = msg([
			{ type: "text", text: "Let me search." },
			{ type: "server_tool_use", id: "u1", name: "web_search", input: { query: "rust" } },
			{
				type: "web_search_tool_result",
				tool_use_id: "u1",
				content: [
					{ type: "web_search_result", url: "https://example.com/1", encrypted_content: "blob1" },
				],
			},
			{ type: "text", text: "Here are the results." },
		]);
		const blocks = extractSearchAssistantBlocks(m);
		expect(blocks).toBeDefined();
		expect(blocks).toHaveLength(2);
		expect(blocks?.[0]?.type).toBe("server_tool_use");
		expect(blocks?.[1]?.type).toBe("web_search_tool_result");
	});

	it("returns undefined when either piece is missing", () => {
		const onlyUse = msg([{ type: "server_tool_use", id: "u1", name: "web_search", input: {} }]);
		expect(extractSearchAssistantBlocks(onlyUse)).toBeUndefined();
		const onlyResult = msg([
			{ type: "web_search_tool_result", tool_use_id: "u1", content: [] },
		]);
		expect(extractSearchAssistantBlocks(onlyResult)).toBeUndefined();
	});

	it("ignores server_tool_use blocks for tools other than web_search", () => {
		const m = msg([
			{ type: "server_tool_use", id: "u1", name: "code_execution", input: {} },
			{ type: "web_search_tool_result", tool_use_id: "u1", content: [] },
		]);
		expect(extractSearchAssistantBlocks(m)).toBeUndefined();
	});
});
