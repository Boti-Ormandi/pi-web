import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RegistryLikeModel, TierResolution } from "../models/tier-resolver.js";
import { showTextViewer } from "../ui/text-viewer.js";

export interface WebModelsCommandOptions {
	getResolution: () => TierResolution;
	getRegistryModels: () => RegistryLikeModel[];
}

function fmt(model: RegistryLikeModel): string {
	const ctx = model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K ctx` : "?";
	const reasoning = model.reasoning ? "reasoning" : "no-reasoning";
	return `  ${model.provider}/${model.id}  [${ctx}, ${reasoning}]`;
}

function suitabilityNote(model: RegistryLikeModel): string {
	const ctx = model.contextWindow ?? 0;
	if (ctx >= 1_000_000) return "    -> good for large pages (1M+ context)";
	if (ctx >= 200_000) return "    -> good for typical pages (200K context)";
	if (ctx < 100_000) return "    -> small context; pre-trim required for large pages";
	return "";
}

export function registerWebModelsCommand(pi: ExtensionAPI, opts: WebModelsCommandOptions): void {
	pi.registerCommand("web-models", {
		description: "Show pi-web tier resolution and the anthropic models pi knows about.",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const resolution = opts.getResolution();
			const models = opts.getRegistryModels();
			const anthropic = models.filter((m) => m.provider === "anthropic").slice().reverse();

			const lines: string[] = [];
			lines.push("pi-web tier resolution:");
			for (const tier of ["fast", "balanced", "strong"] as const) {
				const r = resolution.tiers[tier];
				if (!r) {
					lines.push(`  ${tier.padEnd(8)} -> (unresolved)`);
				} else {
					const ctx = r.model.contextWindow ? `${Math.round(r.model.contextWindow / 1000)}K` : "?";
					lines.push(
						`  ${tier.padEnd(8)} -> ${r.model.provider}/${r.model.id}  [${ctx} ctx, ${r.source}${r.pinnedId ? `=${r.pinnedId}` : ""}]`,
					);
				}
			}
			if (resolution.warnings.length > 0) {
				lines.push("");
				lines.push("Warnings:");
				for (const w of resolution.warnings) lines.push(`  - ${w}`);
			}
			lines.push("");
			lines.push(`Available anthropic models (${anthropic.length}):`);
			for (const m of anthropic) {
				lines.push(fmt(m));
				const note = suitabilityNote(m);
				if (note) lines.push(note);
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			await showTextViewer(ctx, {
				title: `pi-web models (${anthropic.length} anthropic, ${resolution.warnings.length} warnings)`,
				content: lines.join("\n"),
			});
		},
	});
}
