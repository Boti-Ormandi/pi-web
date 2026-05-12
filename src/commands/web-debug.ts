import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface WebDebugCommandOptions {
	getDebug: () => boolean;
	setDebug: (value: boolean) => void;
}

export function registerWebDebugCommand(pi: ExtensionAPI, opts: WebDebugCommandOptions): void {
	pi.registerCommand("web-debug", {
		description: "Toggle pi-web debug logging for this session (on / off / toggle).",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const sub = args.trim().toLowerCase();
			const current = opts.getDebug();
			let next: boolean;
			if (sub === "on" || sub === "true" || sub === "1") next = true;
			else if (sub === "off" || sub === "false" || sub === "0") next = false;
			else next = !current;
			opts.setDebug(next);
			ctx.ui.notify(`pi-web debug: ${next ? "on" : "off"}`, "info");
		},
	});
}
