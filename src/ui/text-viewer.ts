import { matchesKey } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";

export interface TextViewerTheme {
	fg(slot: string, text: string): string;
	bold(text: string): string;
}

/**
 * Read-only modal text viewer.
 *
 * - Esc / q / Enter dismiss.
 * - Up/Down/PageUp/PageDown/Home/End scroll.
 * - Content does not accept edits.
 */
export class TextViewer implements Component {
	private lines: string[];
	private offset = 0;
	private termHeight = 20;
	private title: string;
	private hint: string;
	private theme: TextViewerTheme;
	private done: () => void;

	constructor(title: string, content: string, theme: TextViewerTheme, done: () => void) {
		this.title = title;
		this.lines = content.split("\n");
		this.theme = theme;
		this.done = done;
		this.hint = "Esc / q / Enter to close • arrows, PgUp/PgDn, Home/End, j/k, g/G to scroll";
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || matchesKey(data, "return")) {
			this.done();
			return;
		}
		const page = Math.max(1, this.visibleRows() - 1);
		if (matchesKey(data, "up")) {
			this.offset = Math.max(0, this.offset - 1);
		} else if (matchesKey(data, "down")) {
			this.offset = Math.min(this.maxOffset(), this.offset + 1);
		} else if (matchesKey(data, "pageUp")) {
			this.offset = Math.max(0, this.offset - page);
		} else if (matchesKey(data, "pageDown")) {
			this.offset = Math.min(this.maxOffset(), this.offset + page);
		} else if (matchesKey(data, "home")) {
			this.offset = 0;
		} else if (matchesKey(data, "end")) {
			this.offset = this.maxOffset();
		} else if (data === "j") {
			this.offset = Math.min(this.maxOffset(), this.offset + 1);
		} else if (data === "k") {
			this.offset = Math.max(0, this.offset - 1);
		} else if (data === "g") {
			this.offset = 0;
		} else if (data === "G") {
			this.offset = this.maxOffset();
		}
	}

	invalidate(): void {
		// nothing cached
	}

	render(width: number): string[] {
		const innerWidth = Math.max(20, width - 4);
		const rows = this.visibleRows();
		const total = this.lines.length;
		const maxOffset = Math.max(0, total - rows);
		if (this.offset > maxOffset) this.offset = maxOffset;

		const slice = this.lines.slice(this.offset, this.offset + rows);
		const out: string[] = [];

		const titleLine = this.theme.bold(this.theme.fg("toolTitle", this.title));
		out.push(titleLine);
		out.push(this.theme.fg("dim", "─".repeat(Math.min(80, innerWidth))));

		for (const line of slice) {
			out.push(line);
		}
		const padding = Math.max(0, rows - slice.length);
		for (let i = 0; i < padding; i++) out.push("");

		const pos = total === 0 ? "" : ` [${this.offset + 1}-${Math.min(total, this.offset + rows)}/${total}]`;
		const footer = this.theme.fg("dim", this.hint + pos);
		out.push(this.theme.fg("dim", "─".repeat(Math.min(80, innerWidth))));
		out.push(footer);

		return out;
	}

	private visibleRows(): number {
		// Reserve rows for title, two separators, footer.
		return Math.max(4, this.termHeight - 6);
	}

	private maxOffset(): number {
		return Math.max(0, this.lines.length - this.visibleRows());
	}

	setHeight(termHeight: number): void {
		this.termHeight = termHeight;
	}
}

export interface ShowViewerOptions {
	title: string;
	content: string;
}

/**
 * Show the modal viewer. Returns when the user dismisses.
 */
export async function showTextViewer(
	ctx: {
		ui: {
			custom<T>(
				factory: (tui: unknown, theme: TextViewerTheme, keybindings: unknown, done: (result: T) => void) => Component,
				options?: { overlay?: boolean; overlayOptions?: unknown },
			): Promise<T>;
		};
	},
	opts: ShowViewerOptions,
): Promise<void> {
	await ctx.ui.custom<void>(
		(_tui, theme, _keybindings, done) => {
			const viewer = new TextViewer(opts.title, opts.content, theme, () => done(undefined));
			return viewer;
		},
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "80%", maxHeight: "80%" },
		},
	);
}
