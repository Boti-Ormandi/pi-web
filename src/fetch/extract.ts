import { Readability } from "@mozilla/readability";
import iconv from "iconv-lite";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { extractPdf } from "./pdf.js";

export interface ExtractionResult {
	kind: "html" | "json" | "text" | "binary" | "pdf";
	title?: string;
	byline?: string;
	siteName?: string;
	markdown: string;
	bytesIn: number;
	textBytes: number;
	usedReadability: boolean;
	pageCount?: number;
}

const NON_CONTENT_SELECTORS = [
	"script",
	"style",
	"noscript",
	"svg",
	"iframe",
	"object",
	"embed",
	"form",
	"footer",
	"nav",
	"aside",
	".ad",
	".ads",
	".advert",
	".advertisement",
	".cookie",
	".cookie-banner",
	".cookie-notice",
	".newsletter",
	".popup",
	".modal",
	"[role=banner]",
	"[role=navigation]",
	"[role=complementary]",
	"[role=contentinfo]",
	"[aria-hidden=true]",
];

function buildTurndown(): TurndownService {
	const td = new TurndownService({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
		emDelimiter: "_",
		linkStyle: "inlined",
	});
	td.use(gfm);
	td.addRule("dropImageDataUrls", {
		filter: (node) =>
			node.nodeName === "IMG" &&
			(node.getAttribute("src") ?? "").startsWith("data:"),
		replacement: (_content, node) => {
			const alt = (node as HTMLElement).getAttribute("alt");
			return alt ? `[image: ${alt}]` : "";
		},
	});
	td.addRule("absoluteHref", {
		filter: (node) => node.nodeName === "A" && !!node.getAttribute("href"),
		replacement: (content, node) => {
			const href = (node as HTMLElement).getAttribute("href") ?? "";
			if (!content.trim()) return "";
			return `[${content}](${href})`;
		},
	});
	return td;
}

const turndown = buildTurndown();

function parseCharset(contentType: string): string | undefined {
	const m = contentType.match(/charset=([^;]+)/i);
	if (!m) return undefined;
	return m[1]!.trim().toLowerCase().replace(/^"|"$/g, "");
}

function decode(bytes: Uint8Array, contentType: string, htmlSniff?: string): string {
	let charset = parseCharset(contentType);
	if (!charset && htmlSniff) {
		const meta = htmlSniff.match(/<meta[^>]+charset=["']?([\w-]+)/i);
		if (meta) charset = meta[1]!.toLowerCase();
	}
	if (!charset) charset = "utf-8";
	if (charset === "utf-8" || charset === "utf8") {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
	try {
		return iconv.decode(Buffer.from(bytes), charset);
	} catch {
		return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	}
}

function classifyContentType(contentType: string): ExtractionResult["kind"] {
	const ct = contentType.toLowerCase();
	if (ct.includes("application/pdf")) return "pdf";
	if (ct.includes("application/json") || ct.includes("+json")) return "json";
	if (ct.includes("text/html") || ct.includes("application/xhtml")) return "html";
	if (ct.includes("text/")) return "text";
	return "binary";
}

function stripNoise(document: Document): void {
	for (const selector of NON_CONTENT_SELECTORS) {
		const nodes = document.querySelectorAll(selector);
		for (const node of Array.from(nodes)) {
			node.parentNode?.removeChild(node);
		}
	}
}

function extractMetaTitle(document: Document): string | undefined {
	const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
	if (ogTitle) return ogTitle.trim();
	const title = document.querySelector("title")?.textContent;
	if (title) return title.trim();
	return undefined;
}

function extractMetaSite(document: Document): string | undefined {
	const og = document.querySelector('meta[property="og:site_name"]')?.getAttribute("content");
	return og?.trim();
}

function htmlToMarkdown(html: string): string {
	try {
		return turndown.turndown(html).trim();
	} catch {
		// Strip tags as fallback.
		return html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim();
	}
}

export function extractHtml(html: string): {
	markdown: string;
	title?: string;
	byline?: string;
	siteName?: string;
	usedReadability: boolean;
} {
	let dom: ReturnType<typeof parseHTML>;
	try {
		dom = parseHTML(html);
	} catch {
		return {
			markdown: htmlToMarkdown(html),
			usedReadability: false,
		};
	}
	const document = dom.document as unknown as Document;
	const docTitle = extractMetaTitle(document);
	const siteName = extractMetaSite(document);

	try {
		const readable = new Readability(document.cloneNode(true) as Document, {
			charThreshold: 200,
		}).parse();
		if (readable && readable.content && (readable.length ?? 0) > 150) {
			const markdown = htmlToMarkdown(readable.content);
			return {
				markdown,
				title: readable.title ?? docTitle,
				byline: readable.byline ?? undefined,
				siteName,
				usedReadability: true,
			};
		}
	} catch {
		// fall through to noise-strip path
	}

	stripNoise(document);
	const body = document.body ?? document.documentElement;
	const markdown = htmlToMarkdown((body as unknown as HTMLElement).innerHTML ?? "");
	return {
		markdown,
		title: docTitle,
		siteName,
		usedReadability: false,
	};
}

export function extractJson(text: string): string {
	try {
		const parsed = JSON.parse(text);
		return "```json\n" + JSON.stringify(parsed, null, 2) + "\n```";
	} catch {
		return text;
	}
}

export async function extractContent(
	bytes: Uint8Array,
	contentType: string,
): Promise<ExtractionResult> {
	const kind = classifyContentType(contentType);
	const bytesIn = bytes.byteLength;

	if (kind === "binary") {
		return {
			kind: "binary",
			markdown: `[Binary content (${contentType}, ${bytesIn} bytes) — pi-web cannot extract this. Use a different URL or fetch tool.]`,
			bytesIn,
			textBytes: 0,
			usedReadability: false,
		};
	}

	if (kind === "pdf") {
		try {
			const pdf = await extractPdf(bytes);
			return {
				kind: "pdf",
				markdown: pdf.markdown,
				title: pdf.title,
				byline: pdf.author,
				bytesIn,
				textBytes: pdf.markdown.length,
				usedReadability: false,
				pageCount: pdf.pageCount,
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				kind: "pdf",
				markdown: `[PDF content (${bytesIn} bytes) — extraction failed: ${msg}]`,
				bytesIn,
				textBytes: 0,
				usedReadability: false,
			};
		}
	}

	const head = bytes.subarray(0, Math.min(bytes.byteLength, 2048));
	const sniff = new TextDecoder("utf-8", { fatal: false }).decode(head);
	const text = decode(bytes, contentType, sniff);

	if (kind === "json") {
		const markdown = extractJson(text);
		return {
			kind: "json",
			markdown,
			bytesIn,
			textBytes: markdown.length,
			usedReadability: false,
		};
	}

	if (kind === "html") {
		const result = extractHtml(text);
		return {
			kind: "html",
			markdown: result.markdown,
			title: result.title,
			byline: result.byline,
			siteName: result.siteName,
			bytesIn,
			textBytes: result.markdown.length,
			usedReadability: result.usedReadability,
		};
	}

	const cleaned = text.replace(/\r\n/g, "\n").trim();
	return {
		kind: "text",
		markdown: cleaned,
		bytesIn,
		textBytes: cleaned.length,
		usedReadability: false,
	};
}
