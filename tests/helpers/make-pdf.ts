function escapePdfString(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export interface MakePdfOptions {
	title?: string;
	author?: string;
	pages: string[][];
}

export function makeTinyPdf(opts: MakePdfOptions): Uint8Array {
	const pages = opts.pages;
	if (pages.length === 0) throw new Error("makeTinyPdf: need at least one page");

	const fontObjId = 1;
	const catalogObjId = 2;
	const pagesObjId = 3;
	const pageObjIds: number[] = [];
	const contentObjIds: number[] = [];
	let nextId = 4;
	for (let i = 0; i < pages.length; i++) {
		pageObjIds.push(nextId++);
		contentObjIds.push(nextId++);
	}
	const infoObjId = opts.title || opts.author ? nextId++ : 0;
	const totalObjects = nextId - 1;

	const objects: { id: number; body: string }[] = [];

	objects.push({
		id: fontObjId,
		body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
	});

	objects.push({
		id: catalogObjId,
		body: `<< /Type /Catalog /Pages ${pagesObjId} 0 R >>`,
	});

	objects.push({
		id: pagesObjId,
		body: `<< /Type /Pages /Kids [${pageObjIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
	});

	for (let i = 0; i < pages.length; i++) {
		objects.push({
			id: pageObjIds[i]!,
			body: `<< /Type /Page /Parent ${pagesObjId} 0 R /MediaBox [0 0 612 792] /Contents ${contentObjIds[i]} 0 R /Resources << /Font << /F1 ${fontObjId} 0 R >> >> >>`,
		});

		const lines = pages[i]!;
		const y0 = 750;
		const lineHeight = 18;
		const streamParts: string[] = ["BT", "/F1 12 Tf"];
		for (let li = 0; li < lines.length; li++) {
			const y = y0 - li * lineHeight;
			streamParts.push(`1 0 0 1 72 ${y} Tm`);
			streamParts.push(`(${escapePdfString(lines[li]!)}) Tj`);
		}
		streamParts.push("ET");
		const stream = streamParts.join("\n");
		const streamBytes = Buffer.byteLength(stream, "utf8");
		objects.push({
			id: contentObjIds[i]!,
			body: `<< /Length ${streamBytes} >>\nstream\n${stream}\nendstream`,
		});
	}

	if (infoObjId) {
		const parts: string[] = [];
		if (opts.title) parts.push(`/Title (${escapePdfString(opts.title)})`);
		if (opts.author) parts.push(`/Author (${escapePdfString(opts.author)})`);
		objects.push({ id: infoObjId, body: `<< ${parts.join(" ")} >>` });
	}

	objects.sort((a, b) => a.id - b.id);

	const header = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
	const chunks: Buffer[] = [Buffer.from(header, "binary")];
	const offsets: number[] = new Array(totalObjects + 1).fill(0);
	let cursor = chunks[0]!.length;

	for (const obj of objects) {
		offsets[obj.id] = cursor;
		const text = `${obj.id} 0 obj\n${obj.body}\nendobj\n`;
		const buf = Buffer.from(text, "binary");
		chunks.push(buf);
		cursor += buf.length;
	}

	const xrefStart = cursor;
	const xrefLines: string[] = [`xref`, `0 ${totalObjects + 1}`, `0000000000 65535 f `];
	for (let id = 1; id <= totalObjects; id++) {
		const off = offsets[id]!.toString().padStart(10, "0");
		xrefLines.push(`${off} 00000 n `);
	}
	const xref = xrefLines.join("\n") + "\n";
	chunks.push(Buffer.from(xref, "binary"));

	const trailerParts = [`/Size ${totalObjects + 1}`, `/Root ${catalogObjId} 0 R`];
	if (infoObjId) trailerParts.push(`/Info ${infoObjId} 0 R`);
	const trailer = `trailer\n<< ${trailerParts.join(" ")} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
	chunks.push(Buffer.from(trailer, "binary"));

	return new Uint8Array(Buffer.concat(chunks));
}
