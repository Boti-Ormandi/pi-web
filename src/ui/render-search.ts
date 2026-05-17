import { Text } from "@earendil-works/pi-tui";
import type { WebSearchDetails, WebSearchInput } from "../tools/web-search.js";
import type { Config } from "../config/schema.js";
import { formatCost, formatMs, shortModelLabel, shouldShowCost } from "./cost.js";

let configRef: (() => Config) | undefined;
let debugRef: (() => boolean) | undefined;

export function bindSearchRendererConfig(getConfig: () => Config, getDebug: () => boolean): void {
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

const WEB_SEARCH_ERROR_LABELS: Record<string, string> = {
	too_many_requests: "rate-limited",
	invalid_input: "invalid query",
	max_uses_exceeded: "maximum search uses exceeded",
	query_too_long: "query too long",
	unavailable: "web_search unavailable",
};

function fmtTitle(theme: Theme, args: WebSearchInput): string {
	const title = theme.fg("toolTitle", theme.bold("WebSearch "));
	const queryPart = args.query ? theme.fg("muted", `"${truncate(args.query, 80)}"`) : "";
	const parts: string[] = [title + queryPart];
	const flags: string[] = [];
	if (args.max_results !== undefined) flags.push(`max_results=${args.max_results}`);
	if (args.tier) flags.push(`tier=${args.tier}`);
	if (args.orchestrator_model) flags.push(`model=${args.orchestrator_model}`);
	if (args.allowed_domains?.length) flags.push(`allow=${args.allowed_domains.join(",")}`);
	if (args.blocked_domains?.length) flags.push(`block=${args.blocked_domains.join(",")}`);
	if (args.include_synthesis) flags.push("synthesis=on");
	if (flags.length > 0) parts.push(theme.fg("dim", flags.join(" ")));
	return parts.join(" ");
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "…";
}

export function renderSearchCall(args: WebSearchInput, theme: Theme): import("@earendil-works/pi-tui").Component {
	return new Text(fmtTitle(theme, args), 0, 0);
}

export function renderSearchResult(
	result: { content: { type: string; text?: string }[]; details?: WebSearchDetails; isError?: boolean },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): import("@earendil-works/pi-tui").Component {
	const details = result.details;
	if (options.isPartial) {
		const text = result.content?.[0];
		const msg = text && typeof text.text === "string" ? text.text : "searching...";
		return new Text(theme.fg("warning", msg), 0, 0);
	}
	if (!details) {
		const text = result.content?.[0];
		return new Text(text && typeof text.text === "string" ? text.text : "", 0, 0);
	}
	if (details.errorCode) {
		const label = WEB_SEARCH_ERROR_LABELS[details.errorCode];
		const msg = label ? `Error: ${label} (${details.errorCode})` : `Error: ${details.errorCode}`;
		return new Text(theme.fg("error", msg), 0, 0);
	}
	const cfg = getConfig();
	const debug = getDebug();
	const showCost = cfg ? shouldShowCost(cfg, debug) : false;

	const model = theme.fg("muted", shortModelLabel(details.model));
	const cached = details.cached ? theme.fg("dim", "(cached)") : "";
	const elapsed = theme.fg("dim", `(${formatMs(details.elapsedMs)})`);
	const cost = showCost && details.cost ? theme.fg("dim", formatCost(details.cost)) : "";

	const outcome = theme.fg("success", `${details.resultCount} results`);
	const tail = [model, cached, elapsed, cost].filter((s) => s.length > 0).join(" ");
	const head = [outcome, tail].filter((s) => s.length > 0).join("  ");

	if (!options.expanded) {
		return new Text(head, 0, 0);
	}

	const lines: string[] = [head];
	details.results.forEach((r, i) => {
		const idx = theme.fg("dim", `${(i + 1).toString().padStart(2, " ")}.`);
		lines.push(`  ${idx} ${theme.fg("accent", r.title || "(no title)")}`);
		lines.push(`      ${theme.fg("muted", r.url)}`);
		if (r.pageAge) lines.push(`      ${theme.fg("dim", `page age: ${r.pageAge}`)}`);
	});
	if (details.usage) {
		lines.push("");
		lines.push(
			`  ${theme.fg("dim", "Usage:")} ${theme.fg("muted", `in=${details.usage.input_tokens ?? 0} out=${details.usage.output_tokens ?? 0}`)}`,
		);
	}
	if (details.synthesis) {
		lines.push("");
		lines.push(theme.fg("muted", "Synthesis:"));
		for (const ln of details.synthesis.split("\n")) lines.push("  " + theme.fg("dim", ln));
	}
	return new Text(lines.join("\n"), 0, 0);
}
