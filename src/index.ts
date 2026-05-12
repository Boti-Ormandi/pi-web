import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MemoryCache } from "./cache/store.js";
import { CitationContextCache } from "./cache/citation-context.js";
import { DiskCacheBackend, defaultCacheDir } from "./cache/disk.js";
import { loadConfig, type CliFlagOverlay } from "./config/loader.js";
import type { Config, ResolvedConfig } from "./config/schema.js";
import { registerWebConfigCommand } from "./commands/web-config.js";
import { registerWebModelsCommand } from "./commands/web-models.js";
import { registerWebDebugCommand } from "./commands/web-debug.js";
import { registerWebCacheCommand } from "./commands/web-cache.js";
import {
	resolveTiers,
	type RegistryLikeModel,
	type TierResolution,
} from "./models/tier-resolver.js";
import { createWebSearchTool } from "./tools/web-search.js";
import { createWebFetchTool } from "./tools/web-fetch.js";
import { bindSearchRendererConfig } from "./ui/render-search.js";
import { bindFetchRendererConfig } from "./ui/render-fetch.js";

export default function (pi: ExtensionAPI): void {
	pi.registerFlag("web-no-cache", {
		description: "pi-web: disable cache for this session.",
		type: "boolean",
		default: false,
	});
	pi.registerFlag("web-summary-model", {
		description: "pi-web: pin summarizer to this provider/id (overrides balanced tier).",
		type: "string",
	});
	pi.registerFlag("web-debug", {
		description: "pi-web: enable debug logging for this session.",
		type: "boolean",
		default: false,
	});

	const readCliFlags = (): CliFlagOverlay => ({
		noCache: pi.getFlag("web-no-cache") === true,
		summaryModel:
			typeof pi.getFlag("web-summary-model") === "string"
				? (pi.getFlag("web-summary-model") as string)
				: undefined,
		debug: pi.getFlag("web-debug") === true,
	});

	let resolved: ResolvedConfig = loadConfig({ cwd: process.cwd(), cliFlags: readCliFlags() });
	let registryModels: RegistryLikeModel[] = [];
	let resolution: TierResolution = { tiers: { fast: undefined, balanced: undefined, strong: undefined }, warnings: [] };
	let debugMode = readCliFlags().debug ?? false;

	const cache = new MemoryCache<{
		content: { type: "text"; text: string }[];
		details: unknown;
	}>({
		enabled: resolved.config.cache.enabled,
		ttlSeconds: resolved.config.cache.ttl_seconds,
		maxEntries: resolved.config.cache.max_entries,
	});

	const citationContext = new CitationContextCache({
		ttlSeconds: resolved.config.cache.ttl_seconds,
		maxEntries: resolved.config.cache.max_entries,
	});

	let diskBackend: DiskCacheBackend<{
		content: { type: "text"; text: string }[];
		details: unknown;
	}> | undefined;
	let diskWarningShown = false;

	const attachDiskBackendIfEnabled = (ctx?: import("@earendil-works/pi-coding-agent").ExtensionContext): void => {
		const wanted = resolved.config.cache.persist_to_disk && resolved.config.cache.enabled;
		if (wanted && !diskBackend) {
			diskBackend = new DiskCacheBackend({
				dir: defaultCacheDir(),
				onError: (err, op) => {
					if (diskWarningShown) return;
					diskWarningShown = true;
					const msg = `pi-web disk cache ${op} failed: ${err.message}`;
					if (ctx) ctx.ui.notify(msg, "warning");
				},
			});
			cache.setPersistence(diskBackend.toHook());
			try {
				const entries = diskBackend.loadAll();
				if (entries.length > 0) cache.restore(entries);
			} catch (err) {
				if (ctx) ctx.ui.notify(`pi-web disk cache load failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
			}
		} else if (!wanted && diskBackend) {
			cache.setPersistence(undefined);
			diskBackend = undefined;
		}
	};

	const getConfig = (): Config => resolved.config;
	const getResolution = (): TierResolution => resolution;
	const getRegistryModels = (): RegistryLikeModel[] => registryModels;
	const getDebug = (): boolean => debugMode;

	bindSearchRendererConfig(getConfig, getDebug);
	bindFetchRendererConfig(getConfig, getDebug);

	const reloadConfig = (): ResolvedConfig => {
		resolved = loadConfig({ cwd: process.cwd(), cliFlags: readCliFlags() });
		cache.updateOptions({
			enabled: resolved.config.cache.enabled,
			ttlSeconds: resolved.config.cache.ttl_seconds,
			maxEntries: resolved.config.cache.max_entries,
		});
		citationContext.updateOptions({
			ttlSeconds: resolved.config.cache.ttl_seconds,
			maxEntries: resolved.config.cache.max_entries,
		});
		resolution = resolveTiers(registryModels, resolved.config);
		attachDiskBackendIfEnabled();
		return resolved;
	};

	const setDebug = (value: boolean): void => {
		debugMode = value;
	};

	pi.on("session_start", async (_event, ctx) => {
		registryModels = ctx.modelRegistry.getAvailable() as unknown as RegistryLikeModel[];
		resolution = resolveTiers(registryModels, resolved.config);
		for (const w of resolution.warnings) {
			ctx.ui.notify(`pi-web: ${w}`, "warning");
		}
		attachDiskBackendIfEnabled(ctx);
	});

	pi.registerTool(
		createWebSearchTool({
			getConfig,
			getResolution,
			getRegistryModels,
			cache: cache as unknown as MemoryCache<{
				content: { type: "text"; text: string }[];
				details: import("./tools/web-search.js").WebSearchDetails;
			}>,
			citationContext,
			debug: getDebug,
		}),
	);

	pi.registerTool(
		createWebFetchTool({
			getConfig,
			getResolution,
			getRegistryModels,
			cache: cache as unknown as MemoryCache<{
				content: { type: "text"; text: string }[];
				details: import("./tools/web-fetch.js").WebFetchDetails;
			}>,
			citationContext,
			debug: getDebug,
		}),
	);

	registerWebConfigCommand(pi, { reloadConfig });
	registerWebModelsCommand(pi, { getResolution, getRegistryModels });
	registerWebDebugCommand(pi, { getDebug, setDebug });
	registerWebCacheCommand(pi, { cache, getConfig });
}
