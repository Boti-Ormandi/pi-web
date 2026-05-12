import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractContent } from "../src/fetch/extract.js";
import { makeTinyPdf } from "./helpers/make-pdf.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pages");

function loadBytes(name: string): Uint8Array {
	return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

describe("extractContent (HTML)", () => {
	it("extracts article body via readability and strips nav/ads/scripts", async () => {
		const result = await extractContent(loadBytes("article.html"), "text/html; charset=utf-8");
		expect(result.kind).toBe("html");
		expect(result.title).toContain("Quantization-aware training");
		expect(result.markdown).toContain("PyTorch 2.5");
		expect(result.markdown).toContain("Workflow");
		expect(result.markdown).toContain("prepare_qat");
		// Junk should be gone.
		expect(result.markdown).not.toContain("tracking goes here");
		expect(result.markdown).not.toContain("Buy our t-shirts");
		expect(result.markdown).not.toContain("Accept to continue");
	});

	it("handles short pages without crashing (non-readable fallback)", async () => {
		const result = await extractContent(loadBytes("minimal.html"), "text/html; charset=utf-8");
		expect(result.kind).toBe("html");
		expect(result.markdown).toContain("Hello");
		expect(result.markdown).toContain("tiny page");
		expect(result.markdown).not.toContain("alert");
	});
});

describe("extractContent (JSON / text / binary)", () => {
	it("pretty-prints JSON", async () => {
		const bytes = new TextEncoder().encode('{"a":1,"b":[2,3]}');
		const r = await extractContent(bytes, "application/json");
		expect(r.kind).toBe("json");
		expect(r.markdown).toContain('"a": 1');
		expect(r.markdown).toContain("```json");
	});

	it("passes plain text through", async () => {
		const bytes = new TextEncoder().encode("Hello\r\nWorld");
		const r = await extractContent(bytes, "text/plain; charset=utf-8");
		expect(r.kind).toBe("text");
		expect(r.markdown).toContain("Hello\nWorld");
	});

	it("marks binary content with a clear note", async () => {
		const r = await extractContent(new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
		expect(r.kind).toBe("binary");
		expect(r.markdown).toMatch(/binary content/i);
	});

	it("surfaces a parse error when given bytes that aren't a PDF", async () => {
		const r = await extractContent(new Uint8Array(8), "application/pdf");
		expect(r.kind).toBe("pdf");
		expect(r.markdown).toMatch(/extraction failed/i);
	});
});

describe("extractContent (PDF)", () => {
	it("extracts text from a multi-page PDF, preserving page boundaries and metadata", async () => {
		const bytes = makeTinyPdf({
			title: "Quantization Notes",
			author: "pi-web tests",
			pages: [
				["Introduction", "PyTorch 2.5 introduces new quantization APIs."],
				["Workflow", "Call prepare_qat then convert."],
			],
		});
		const r = await extractContent(bytes, "application/pdf");
		expect(r.kind).toBe("pdf");
		expect(r.pageCount).toBe(2);
		expect(r.title).toBe("Quantization Notes");
		expect(r.byline).toBe("pi-web tests");
		expect(r.markdown).toContain("# Quantization Notes");
		expect(r.markdown).toContain("## Page 1");
		expect(r.markdown).toContain("## Page 2");
		expect(r.markdown).toContain("Introduction");
		expect(r.markdown).toContain("prepare_qat");
		expect(r.markdown).toContain("PyTorch 2.5");
		expect(r.textBytes).toBeGreaterThan(0);
	});

	it("handles a PDF with no metadata", async () => {
		const bytes = makeTinyPdf({
			pages: [["Just one line of text."]],
		});
		const r = await extractContent(bytes, "application/pdf");
		expect(r.kind).toBe("pdf");
		expect(r.pageCount).toBe(1);
		expect(r.title).toBeUndefined();
		expect(r.byline).toBeUndefined();
		expect(r.markdown).toContain("Just one line of text.");
		expect(r.markdown.startsWith("## Page 1")).toBe(true);
	});
});
