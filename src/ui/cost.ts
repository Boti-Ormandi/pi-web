import type { Config, CostDisplay } from "../config/schema.js";

export function shouldShowCost(cfg: Config, debug: boolean): boolean {
	const mode: CostDisplay = cfg.display.show_cost;
	if (mode === "always") return true;
	if (mode === "debug") return debug;
	return false;
}

export function formatCost(cost: number | undefined): string {
	if (cost === undefined || cost === null || !Number.isFinite(cost)) return "";
	if (cost < 0.001) return "<$0.001";
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "0B";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
}

export function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

export function shortModelLabel(modelId: string | undefined): string {
	if (!modelId) return "";
	const id = modelId.includes("/") ? modelId.split("/")[1] ?? modelId : modelId;
	return id.replace(/^claude-/, "");
}

export function shortenUrl(u: string, max = 60): string {
	if (u.length <= max) return u;
	return u.slice(0, max - 1) + "…";
}
