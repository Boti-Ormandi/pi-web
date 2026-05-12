import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MemoryCache } from "../cache/store.js";
import type { Config } from "../config/schema.js";
import { showTextViewer } from "../ui/text-viewer.js";

export interface WebCacheCommandOptions {
	cache: MemoryCache<unknown>;
	getConfig: () => Config;
}

function fmtBytes(n: number): string {
	if (n < 1024) return `${n}B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
	return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

function fmtAgo(ms: number, nowMs: number): string {
	const delta = Math.max(0, nowMs - ms);
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	return `${Math.floor(s / 3600)}h ago`;
}

function fmtTtl(expiresAt: number, nowMs: number): string {
	const delta = expiresAt - nowMs;
	if (delta <= 0) return "expired";
	const s = Math.floor(delta / 1000);
	if (s < 60) return `${s}s left`;
	if (s < 3600) return `${Math.floor(s / 60)}m left`;
	return `${Math.floor(s / 3600)}h left`;
}

function shortKey(key: string): string {
	const parts = key.split(":");
	if (parts.length < 3) return key;
	const tail = parts[2] ?? "";
	return `${parts[0]}:${parts[1]}:${tail.slice(0, 12)}…`;
}

function summarize(cache: MemoryCache<unknown>, config: Config): string {
	const stats = cache.getStats();
	const lines: string[] = [];
	lines.push("pi-web cache stats:");
	lines.push(`  enabled        ${config.cache.enabled ? "yes" : "no"}`);
	lines.push(`  ttl_seconds    ${config.cache.ttl_seconds}`);
	lines.push(`  max_entries    ${config.cache.max_entries}`);
	lines.push(`  persist_to_disk ${config.cache.persist_to_disk ? "yes" : "no"}`);
	lines.push("");
	lines.push(`  entries        ${stats.entries}`);
	lines.push(`  bytes          ${fmtBytes(stats.bytes)}`);
	lines.push(`  hits           ${stats.hits}`);
	lines.push(`  misses         ${stats.misses}`);
	lines.push(`  evictions      ${stats.evictions}`);
	return lines.join("\n");
}

function listEntries(cache: MemoryCache<unknown>): string {
	const now = Date.now();
	const entries = cache.entries();
	const lines: string[] = [];
	lines.push(`pi-web cache entries (${entries.length}):`);
	if (entries.length === 0) {
		lines.push("  (empty)");
		return lines.join("\n");
	}
	const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt);
	for (const e of sorted) {
		const tagLabel = e.tag ? `[${e.tag}]` : "[?]";
		lines.push(
			`  ${tagLabel.padEnd(16)} ${shortKey(e.key).padEnd(28)} ${fmtBytes(e.sizeBytes).padStart(8)}  ${fmtAgo(e.createdAt, now).padEnd(10)} ${fmtTtl(e.expiresAt, now)}`,
		);
	}
	return lines.join("\n");
}

export function registerWebCacheCommand(pi: ExtensionAPI, opts: WebCacheCommandOptions): void {
	pi.registerCommand("web-cache", {
		description:
			"Inspect or manage pi-web's cache. Subcommands: stats (default), list, clear, clear-expired.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			const config = opts.getConfig();

			if (sub === "" || sub === "stats") {
				const text = summarize(opts.cache, config);
				if (!ctx.hasUI) {
					ctx.ui.notify(text, "info");
					return;
				}
				await showTextViewer(ctx, { title: "pi-web cache stats", content: text });
				return;
			}

			if (sub === "list") {
				const text = listEntries(opts.cache);
				if (!ctx.hasUI) {
					ctx.ui.notify(text, "info");
					return;
				}
				await showTextViewer(ctx, {
					title: `pi-web cache entries (${opts.cache.getStats().entries})`,
					content: text,
				});
				return;
			}

			if (sub === "clear") {
				const stats = opts.cache.getStats();
				if (stats.entries === 0) {
					ctx.ui.notify("pi-web cache already empty.", "info");
					return;
				}
				let proceed = true;
				if (ctx.hasUI) {
					proceed = await ctx.ui.confirm(
						"Clear pi-web cache?",
						`${stats.entries} entries, ${fmtBytes(stats.bytes)} will be discarded.`,
					);
				}
				if (!proceed) {
					ctx.ui.notify("pi-web cache clear cancelled.", "info");
					return;
				}
				opts.cache.clear();
				ctx.ui.notify(`pi-web cache cleared (${stats.entries} entries).`, "info");
				return;
			}

			if (sub === "clear-expired") {
				const now = Date.now();
				const expired = opts.cache.entries().filter((e) => e.expiresAt <= now);
				if (expired.length === 0) {
					ctx.ui.notify("pi-web cache: no expired entries.", "info");
					return;
				}
				for (const e of expired) opts.cache.delete(e.key);
				ctx.ui.notify(`pi-web cache: removed ${expired.length} expired entries.`, "info");
				return;
			}

			ctx.ui.notify(
				`Unknown /web-cache subcommand "${sub}". Use: stats | list | clear | clear-expired.`,
				"warning",
			);
		},
	});
}
