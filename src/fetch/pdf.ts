import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface PdfExtractionResult {
	markdown: string;
	pageCount: number;
	title?: string;
	author?: string;
}

interface TextItem {
	str: string;
	transform?: number[];
	hasEOL?: boolean;
}

function isTextItem(item: unknown): item is TextItem {
	return typeof (item as { str?: unknown }).str === "string";
}

function pageItemsToText(items: TextItem[]): string {
	const out: string[] = [];
	let prevY: number | undefined;
	let currentLine = "";

	const flush = () => {
		const trimmed = currentLine.replace(/\s+/g, " ").trim();
		if (trimmed) out.push(trimmed);
		else if (out.length && out[out.length - 1] !== "") out.push("");
		currentLine = "";
	};

	for (const item of items) {
		if (!item.str) {
			if (item.hasEOL) flush();
			continue;
		}
		const y = item.transform?.[5] ?? 0;
		if (prevY !== undefined && Math.abs(prevY - y) > 2) {
			flush();
		}
		currentLine += item.str;
		if (item.hasEOL) {
			flush();
			prevY = undefined;
		} else {
			prevY = y;
		}
	}
	flush();

	while (out.length && out[out.length - 1] === "") out.pop();
	return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtractionResult> {
	const data = new Uint8Array(bytes);
	const loadingTask = getDocument({
		data,
		disableFontFace: true,
		useSystemFonts: false,
		isEvalSupported: false,
		verbosity: 0,
	});
	const doc = await loadingTask.promise;
	try {
		const pageCount = doc.numPages;
		const pageMarkdowns: string[] = [];
		let title: string | undefined;
		let author: string | undefined;

		try {
			const metadata = await doc.getMetadata();
			const info = metadata.info as Record<string, unknown> | undefined;
			if (info) {
				const t = info.Title;
				const a = info.Author;
				if (typeof t === "string" && t.trim()) title = t.trim();
				if (typeof a === "string" && a.trim()) author = a.trim();
			}
		} catch {
			// metadata is optional
		}

		for (let i = 1; i <= pageCount; i++) {
			const page = await doc.getPage(i);
			try {
				const content = await page.getTextContent();
				const textItems = (content.items as unknown[]).filter(isTextItem);
				const pageText = pageItemsToText(textItems);
				if (pageText) {
					pageMarkdowns.push(`## Page ${i}\n\n${pageText}`);
				} else {
					pageMarkdowns.push(`## Page ${i}\n\n_(no extractable text)_`);
				}
			} finally {
				page.cleanup();
			}
		}

		const header: string[] = [];
		if (title) header.push(`# ${title}`);
		if (author) header.push(`_by ${author}_`);
		const headerText = header.length ? header.join("\n\n") + "\n\n" : "";

		return {
			markdown: (headerText + pageMarkdowns.join("\n\n")).trim(),
			pageCount,
			title,
			author,
		};
	} finally {
		await doc.destroy();
	}
}
