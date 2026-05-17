import { Text } from "@earendil-works/pi-tui";
import type { Config } from "../config/schema.js";
import type { WebFetchDetails, WebFetchInput } from "../tools/web-fetch.js";
import { formatBytes, formatCost, formatMs, shortModelLabel, shortenUrl, shouldShowCost } from "./cost.js";

let configRef: (() => Config) | undefined;
let debugRef: (() => boolean) | undefined;

export function bindFetchRendererConfig(getConfig: () => Config, getDebug: () => boolean): void {
	configRef = getConfig;
	debugRef = getDebug;
}

function getConfig(): Config | undefined {
	return configRef?.();
}

function getDebug(): boolean {
	return debugRef?.() ?? false;
}

type Theme = {
	fg(slot: string, text: string): string;
	bold(text: string): string;
};

function fmtCall(theme: Theme, args: WebFetchInput): string {
	const title = theme.fg("toolTitle", theme.bold("WebFetch "));
	const url = theme.fg("muted", shortenUrl(args.url ?? "", 80));
	const flags: string[] = [];
	const backend = args.backend ?? "client";
	if (backend === "server") flags.push("backend=server");
	const mode = args.mode ?? (args.prompt ? "summary" : "raw");
	if (backend !== "server") flags.push(`mode=${mode}`);
	if (args.summary_tier) flags.push(`tier=${args.summary_tier}`);
	if (args.summary_model) flags.push(`model=${args.summary_model}`);
	if (args.thinking_budget) flags.push(`thinking=${args.thinking_budget}`);
	if (args.raw_max_bytes && backend !== "server") flags.push(`raw_max_bytes=${args.raw_max_bytes}`);
	if (args.max_content_tokens) flags.push(`max_content_tokens=${args.max_content_tokens}`);
	if (args.prompt) flags.push(`prompt="${truncate(args.prompt, 40)}"`);
	const parts: string[] = [title + url];
	if (flags.length > 0) parts.push(theme.fg("dim", flags.join(" ")));
	return parts.join(" ");
}

function extractFetchBody(text: string): string {
	const divider = "\n\n---\n\n";
	const dividerIdx = text.indexOf(divider);
	if (dividerIdx !== -1) return text.slice(dividerIdx + divider.length);
	const blankIdx = text.indexOf("\n\n");
	if (blankIdx !== -1) return text.slice(blankIdx + 2);
	return text;
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

export function renderFetchCall(args: WebFetchInput, theme: Theme): import("@earendil-works/pi-tui").Component {
	return new Text(fmtCall(theme, args), 0, 0);
}

export function renderFetchResult(
	result: { content: { type: string; text?: string }[]; details?: WebFetchDetails; isError?: boolean },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): import("@earendil-works/pi-tui").Component {
	const details = result.details;
	if (options.isPartial) {
		const text = result.content?.[0];
		const msg = text && typeof text.text === "string" ? text.text : "fetching...";
		return new Text(theme.fg("warning", msg), 0, 0);
	}
	if (!details) {
		const text = result.content?.[0];
		return new Text(text && typeof text.text === "string" ? text.text : "", 0, 0);
	}
	if (details.error) {
		return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
	}

	const cfg = getConfig();
	const debug = getDebug();
	const showCost = cfg ? shouldShowCost(cfg, debug) : false;

	const cached = details.cached ? theme.fg("dim", "(cached)") : "";
	const elapsed = theme.fg("dim", `(${formatMs(details.elapsedMs)})`);
	const sizeIn = formatBytes(details.bytesIn);
	const sizeOut = formatBytes(details.bytesOut);
	const arrow = theme.fg("dim", "->");
	const cost = showCost && details.cost ? theme.fg("dim", formatCost(details.cost)) : "";
	const backendTag =
		details.backend === "server"
			? details.serverFetchInvoked === false
				? theme.fg("warning", " [server·skipped]")
				: theme.fg("dim", details.citationLinked ? " [server·cite]" : " [server]")
			: "";
	const modelChunk = details.model
		? [
				theme.fg("muted", shortModelLabel(details.model)),
				details.thinkingFired ? theme.fg("dim", "thinking-on") : "",
			]
				.filter((s) => s.length > 0)
				.join(" ")
		: "";

	const outcome = theme.fg("success", details.mode) + backendTag;
	const sizes = theme.fg("muted", `${sizeIn} ${arrow} ${sizeOut}`);
	const tail = [modelChunk, cached, elapsed, cost].filter((s) => s.length > 0).join(" ");
	const head = [outcome, sizes, tail].filter((s) => s.length > 0).join("  ");

	if (!options.expanded) return new Text(head, 0, 0);

	const lines: string[] = [head];
	lines.push(`  ${theme.fg("dim", "URL:")} ${theme.fg("muted", details.finalUrl ?? details.url)}`);
	if (details.pageTitle) lines.push(`  ${theme.fg("dim", "Title:")} ${theme.fg("muted", details.pageTitle)}`);
	if (details.contentType) lines.push(`  ${theme.fg("dim", "Content-Type:")} ${theme.fg("muted", details.contentType)}`);
	if (details.contentKind === "pdf") {
		const pageInfo = details.pageCount ? `${details.pageCount} page${details.pageCount === 1 ? "" : "s"}` : "PDF";
		lines.push(`  ${theme.fg("dim", "Kind:")} ${theme.fg("muted", `PDF (${pageInfo})`)}`);
	} else if (details.usedReadability !== undefined) {
		lines.push(`  ${theme.fg("dim", "Readability:")} ${theme.fg("muted", details.usedReadability ? "yes" : "no")}`);
	}
	if (details.pageTruncated) {
		lines.push(`  ${theme.fg("dim", "Truncated:")} ${theme.fg("warning", `~${details.pageOriginalChars} chars`)}`);
	}
	if (details.model) {
		lines.push(`  ${theme.fg("dim", "Model:")} ${theme.fg("muted", details.model)}`);
	}
	if (details.thinkingFired) {
		lines.push(
			`  ${theme.fg("dim", "Thinking:")} ${theme.fg("muted", `signature ${details.thinkingSignatureChars ?? 0} chars`)}`,
		);
	}
	if (details.thinkingUnavailable) {
		lines.push(`  ${theme.fg("dim", "Thinking:")} ${theme.fg("warning", "requested but model does not support reasoning")}`);
	}
	if (details.usage) {
		lines.push(
			`  ${theme.fg("dim", "Usage:")} ${theme.fg("muted", `in=${details.usage.input_tokens ?? 0} out=${details.usage.output_tokens ?? 0}`)}`,
		);
	}
	if (details.backend) {
		lines.push(`  ${theme.fg("dim", "Backend:")} ${theme.fg("muted", details.backend)}`);
	}
	if (details.backend === "server") {
		if (details.serverFetchInvoked === false) {
			lines.push(`  ${theme.fg("dim", "Fetch invoked:")} ${theme.fg("warning", "no (prior knowledge)")}`);
		}
		const citation = details.citationLinked
			? theme.fg("success", `linked to "${details.citationQuery ?? "(prior search)"}"`)
			: theme.fg("warning", "not linked");
		lines.push(`  ${theme.fg("dim", "Citation:")} ${citation}`);
		if (details.retrievedAt) {
			lines.push(`  ${theme.fg("dim", "Retrieved:")} ${theme.fg("muted", details.retrievedAt)}`);
		}
		if (details.maxContentTokens) {
			lines.push(
				`  ${theme.fg("dim", "max_content_tokens:")} ${theme.fg("muted", String(details.maxContentTokens))}`,
			);
		}
		if (details.serverFetchErrorCode) {
			lines.push(`  ${theme.fg("dim", "Server error:")} ${theme.fg("warning", details.serverFetchErrorCode)}`);
		}
	}
	const text = result.content?.[0];
	if (text && typeof text.text === "string") {
		const body = extractFetchBody(text.text).replace(/^\n+/, "");
		if (body.length > 0) {
			const preview = body.split("\n").slice(0, 12).join("\n");
			lines.push("");
			lines.push(theme.fg("muted", "--- result ---"));
			for (const ln of preview.split("\n")) lines.push("  " + theme.fg("dim", ln));
		}
	}
	return new Text(lines.join("\n"), 0, 0);
}
