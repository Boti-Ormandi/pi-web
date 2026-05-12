import { TIER_FAMILY_PATTERNS } from "../config/defaults.js";
import type { Config, TierConfig, TierName } from "../config/schema.js";

export interface RegistryLikeModel {
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export interface ResolvedTier {
	tier: TierName;
	model: RegistryLikeModel;
	source: "auto" | "pinned";
	pinnedId?: string;
}

export interface TierResolution {
	tiers: Record<TierName, ResolvedTier | undefined>;
	warnings: string[];
}

const VERSION_DIGIT_RE = /(\d+)/g;

/**
 * Parse version digits from an Anthropic model id.
 *
 * `claude-haiku-4-5` -> [4, 5]
 * `claude-haiku-4-5-20251001` -> [4, 5, 20251001]
 * `claude-3-7-sonnet-20250109` -> [3, 7, 20250109]
 */
export function parseVersionVector(modelId: string): number[] {
	const stripped = modelId.replace(/^claude-/, "");
	const out: number[] = [];
	for (const match of stripped.matchAll(VERSION_DIGIT_RE)) {
		const n = Number(match[1]);
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

/**
 * `claude-haiku-4-5` is considered an alias (dateless), `claude-haiku-4-5-20251001` is dated.
 *
 * Heuristic: the trailing token (after stripping `claude-` and the family word)
 * being a date-shaped 8-digit number marks the id as dated.
 */
export function hasDateSuffix(modelId: string): boolean {
	return /-\d{8}$/.test(modelId);
}

function compareModels(a: RegistryLikeModel, b: RegistryLikeModel): number {
	const av = parseVersionVector(a.id);
	const bv = parseVersionVector(b.id);
	const dateA = hasDateSuffix(a.id) ? 1 : 0;
	const dateB = hasDateSuffix(b.id) ? 1 : 0;

	// Compare on version vector excluding the trailing date digits so the
	// alias and the matching dated id share the same comparable vector.
	const trimmedA = dateA ? av.slice(0, -1) : av;
	const trimmedB = dateB ? bv.slice(0, -1) : bv;

	const len = Math.max(trimmedA.length, trimmedB.length);
	for (let i = 0; i < len; i++) {
		const x = trimmedA[i] ?? 0;
		const y = trimmedB[i] ?? 0;
		if (x !== y) return y - x;
	}

	if (dateA !== dateB) return dateA - dateB;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function pickLatestForFamily(
	models: readonly RegistryLikeModel[],
	pattern: RegExp,
): RegistryLikeModel | undefined {
	const candidates = models.filter((m) => m.provider === "anthropic" && pattern.test(m.id));
	if (candidates.length === 0) return undefined;
	const sorted = [...candidates].sort(compareModels);
	return sorted[0];
}

function resolveSingleTier(
	tier: TierName,
	tierConfig: TierConfig,
	models: readonly RegistryLikeModel[],
	allowUnregistered: boolean,
	allowedModels: readonly string[],
	warnings: string[],
): ResolvedTier | undefined {
	if (typeof tierConfig === "string") {
		const [provider, ...rest] = tierConfig.split("/");
		const id = rest.join("/");
		if (!provider || !id) {
			warnings.push(`Tier ${tier}: invalid pin "${tierConfig}", expected "provider/id"`);
			return undefined;
		}
		if (allowedModels.length > 0 && !allowedModels.includes(tierConfig)) {
			warnings.push(`Tier ${tier}: pinned ${tierConfig} not in allowed_models`);
			return undefined;
		}
		const found = models.find((m) => m.provider === provider && m.id === id);
		if (found) {
			return { tier, model: found, source: "pinned", pinnedId: tierConfig };
		}
		if (allowUnregistered) {
			return {
				tier,
				model: { provider, id },
				source: "pinned",
				pinnedId: tierConfig,
			};
		}
		warnings.push(`Tier ${tier}: pinned ${tierConfig} not in registry`);
		return undefined;
	}

	const pattern = TIER_FAMILY_PATTERNS[tier];
	const picked = pickLatestForFamily(models, pattern);
	if (!picked) {
		warnings.push(`Tier ${tier}: no anthropic model matched ${pattern.source} in registry`);
		return undefined;
	}
	if (allowedModels.length > 0) {
		const fq = `${picked.provider}/${picked.id}`;
		if (!allowedModels.includes(fq)) {
			warnings.push(`Tier ${tier}: auto-resolved ${fq} not in allowed_models`);
			return undefined;
		}
	}
	return { tier, model: picked, source: "auto" };
}

export function resolveTiers(
	models: readonly RegistryLikeModel[],
	config: Config,
): TierResolution {
	const warnings: string[] = [];
	const tiers: Record<TierName, ResolvedTier | undefined> = {
		fast: undefined,
		balanced: undefined,
		strong: undefined,
	};
	for (const tier of ["fast", "balanced", "strong"] as const) {
		tiers[tier] = resolveSingleTier(
			tier,
			config.models.tiers[tier],
			models,
			config.models.allow_unregistered,
			config.models.allowed_models,
			warnings,
		);
	}
	return { tiers, warnings };
}

/**
 * Fall back through strong -> balanced -> fast looking for an available tier.
 */
export function tierWithFallback(
	tiers: Record<TierName, ResolvedTier | undefined>,
	requested: TierName,
): ResolvedTier | undefined {
	if (tiers[requested]) return tiers[requested];
	const order: TierName[] = ["strong", "balanced", "fast"];
	for (const t of order) {
		if (tiers[t]) return tiers[t];
	}
	return undefined;
}

/**
 * Find a model in the registry by `provider/id` string, with optional
 * `allow_unregistered` escape.
 */
export function findExplicitModel(
	models: readonly RegistryLikeModel[],
	fqId: string,
	allowUnregistered: boolean,
	allowedModels: readonly string[],
): RegistryLikeModel | { error: string } {
	if (allowedModels.length > 0 && !allowedModels.includes(fqId)) {
		return { error: `Model ${fqId} not in allowed_models` };
	}
	const [provider, ...rest] = fqId.split("/");
	const id = rest.join("/");
	if (!provider || !id) {
		return { error: `Invalid model id "${fqId}", expected "provider/id"` };
	}
	const found = models.find((m) => m.provider === provider && m.id === id);
	if (found) return found;
	if (allowUnregistered) return { provider, id };
	return { error: `Model ${fqId} not in registry (set models.allow_unregistered to override)` };
}
