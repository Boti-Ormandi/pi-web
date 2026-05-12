import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultGlobalConfigPath, defaultProjectConfigPath, loadConfig } from "../config/loader.js";
import type { ResolvedConfig } from "../config/schema.js";
import { showTextViewer } from "../ui/text-viewer.js";

export interface WebConfigCommandOptions {
	reloadConfig: () => ResolvedConfig;
}

function formatResolved(resolved: ResolvedConfig): string {
	const lines: string[] = [];
	lines.push("// pi-web resolved config (last layer wins)");
	lines.push("// Sources (in order):");
	for (const s of resolved.sources) {
		lines.push(`//   - ${s.label}${s.path ? `  (${s.path})` : ""}`);
	}
	lines.push("// Edit this file and save to update project config (.pi/pi-web.json).");
	lines.push("// For global config, edit ~/.pi/agent/extensions/pi-web/config.json.");
	lines.push("");
	lines.push(JSON.stringify(resolved.config, null, 2));
	return lines.join("\n");
}

export function registerWebConfigCommand(pi: ExtensionAPI, opts: WebConfigCommandOptions): void {
	pi.registerCommand("web-config", {
		description: "View and edit pi-web's resolved config. Saves changes to project config.",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/web-config requires interactive mode.", "warning");
				return;
			}
			const projectPath = defaultProjectConfigPath(ctx.cwd);
			const globalPath = defaultGlobalConfigPath();
			const resolved = opts.reloadConfig();

			const sub = args.trim().toLowerCase();
			if (sub === "show" || sub === "view") {
				const text = formatResolved(resolved);
				await showTextViewer(ctx, {
					title: "pi-web config (read-only view)",
					content: text,
				});
				return;
			}
			if (sub === "where" || sub === "paths") {
				ctx.ui.notify(`global: ${globalPath}`, "info");
				ctx.ui.notify(`project: ${projectPath}`, "info");
				return;
			}

			const text = formatResolved(resolved);
			const edited = await ctx.ui.editor("pi-web config (saves to project .pi/pi-web.json)", text);
			if (edited === undefined) {
				ctx.ui.notify("pi-web config edit cancelled.", "info");
				return;
			}
			const jsonText = stripCommentLines(edited);
			let parsed: unknown;
			try {
				parsed = JSON.parse(jsonText);
			} catch (err) {
				ctx.ui.notify(
					`pi-web config invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
				return;
			}
			try {
				if (!existsSync(projectPath)) {
					mkdirSync(dirname(projectPath), { recursive: true });
				}
				writeFileSync(projectPath, JSON.stringify(parsed, null, 2) + "\n", "utf8");
				opts.reloadConfig();
				ctx.ui.notify(`pi-web config saved -> ${projectPath}`, "success" as "info");
			} catch (err) {
				ctx.ui.notify(
					`pi-web config save failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		},
	});
}

function stripCommentLines(text: string): string {
	const lines = text.split("\n");
	const filtered: string[] = [];
	let started = false;
	for (const ln of lines) {
		if (!started) {
			if (ln.trimStart().startsWith("//") || ln.trim() === "") continue;
			started = true;
		}
		filtered.push(ln);
	}
	return filtered.join("\n");
}

export { loadConfig };
