import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config/defaults.js";
import {
	findExplicitModel,
	hasDateSuffix,
	parseVersionVector,
	pickLatestForFamily,
	resolveTiers,
	tierWithFallback,
	type RegistryLikeModel,
} from "../src/models/tier-resolver.js";

function model(provider: string, id: string, ctx = 200_000, reasoning = false): RegistryLikeModel {
	return { provider, id, contextWindow: ctx, maxTokens: 8192, reasoning };
}

describe("parseVersionVector", () => {
	it("parses common claude ids", () => {
		expect(parseVersionVector("claude-haiku-4-5")).toEqual([4, 5]);
		expect(parseVersionVector("claude-haiku-4-5-20251001")).toEqual([4, 5, 20251001]);
		expect(parseVersionVector("claude-3-7-sonnet-20250109")).toEqual([3, 7, 20250109]);
		expect(parseVersionVector("claude-opus-4-7")).toEqual([4, 7]);
	});
});

describe("hasDateSuffix", () => {
	it("recognises 8-digit date tails", () => {
		expect(hasDateSuffix("claude-haiku-4-5-20251001")).toBe(true);
		expect(hasDateSuffix("claude-haiku-4-5")).toBe(false);
		expect(hasDateSuffix("claude-3-haiku-20240307")).toBe(true);
	});
});

describe("pickLatestForFamily", () => {
	it("picks higher version vector first", () => {
		const models: RegistryLikeModel[] = [
			model("anthropic", "claude-haiku-3-5"),
			model("anthropic", "claude-haiku-4-5"),
			model("anthropic", "claude-3-haiku-20240307"),
		];
		const r = pickLatestForFamily(models, /haiku/i);
		expect(r?.id).toBe("claude-haiku-4-5");
	});

	it("prefers dateless alias over dated id at same version", () => {
		const models: RegistryLikeModel[] = [
			model("anthropic", "claude-haiku-4-5-20251001"),
			model("anthropic", "claude-haiku-4-5"),
		];
		const r = pickLatestForFamily(models, /haiku/i);
		expect(r?.id).toBe("claude-haiku-4-5");
	});

	it("ignores non-anthropic providers", () => {
		const models: RegistryLikeModel[] = [
			model("not-anthropic", "claude-haiku-9-9"),
			model("anthropic", "claude-haiku-4-5"),
		];
		const r = pickLatestForFamily(models, /haiku/i);
		expect(r?.id).toBe("claude-haiku-4-5");
	});

	it("returns undefined when no match", () => {
		const models: RegistryLikeModel[] = [model("anthropic", "claude-opus-4-7")];
		expect(pickLatestForFamily(models, /haiku/i)).toBeUndefined();
	});
});

describe("resolveTiers", () => {
	const sampleModels: RegistryLikeModel[] = [
		model("anthropic", "claude-haiku-4-5", 200_000, false),
		model("anthropic", "claude-haiku-4-5-20251001", 200_000, false),
		model("anthropic", "claude-sonnet-4-6", 1_000_000, true),
		model("anthropic", "claude-opus-4-7", 1_000_000, true),
		model("anthropic", "claude-3-7-sonnet-20250109", 200_000, true),
	];

	it("auto-resolves all three tiers against the sample registry", () => {
		const r = resolveTiers(sampleModels, DEFAULTS);
		expect(r.tiers.fast?.model.id).toBe("claude-haiku-4-5");
		expect(r.tiers.balanced?.model.id).toBe("claude-sonnet-4-6");
		expect(r.tiers.strong?.model.id).toBe("claude-opus-4-7");
		expect(r.warnings).toHaveLength(0);
	});

	it("warns when a tier has no candidate", () => {
		const r = resolveTiers([model("anthropic", "claude-sonnet-4-6")], DEFAULTS);
		expect(r.tiers.balanced).toBeDefined();
		expect(r.tiers.fast).toBeUndefined();
		expect(r.tiers.strong).toBeUndefined();
		expect(r.warnings.length).toBeGreaterThan(0);
	});

	it("honours pinned strings", () => {
		const cfg = {
			...DEFAULTS,
			models: {
				...DEFAULTS.models,
				tiers: { ...DEFAULTS.models.tiers, fast: "anthropic/claude-haiku-4-5-20251001" },
			},
		};
		const r = resolveTiers(sampleModels, cfg);
		expect(r.tiers.fast?.model.id).toBe("claude-haiku-4-5-20251001");
		expect(r.tiers.fast?.source).toBe("pinned");
	});

	it("rejects pinned model not in registry without allow_unregistered", () => {
		const cfg = {
			...DEFAULTS,
			models: {
				...DEFAULTS.models,
				tiers: { ...DEFAULTS.models.tiers, fast: "anthropic/claude-haiku-9-9" },
			},
		};
		const r = resolveTiers(sampleModels, cfg);
		expect(r.tiers.fast).toBeUndefined();
		expect(r.warnings.some((w) => w.includes("not in registry"))).toBe(true);
	});

	it("accepts unregistered pins when allow_unregistered is true", () => {
		const cfg = {
			...DEFAULTS,
			models: {
				...DEFAULTS.models,
				allow_unregistered: true,
				tiers: { ...DEFAULTS.models.tiers, fast: "anthropic/claude-haiku-9-9" },
			},
		};
		const r = resolveTiers(sampleModels, cfg);
		expect(r.tiers.fast?.model.id).toBe("claude-haiku-9-9");
	});

	it("tierWithFallback returns requested tier when present", () => {
		const r = resolveTiers(sampleModels, DEFAULTS);
		expect(tierWithFallback(r.tiers, "fast")?.model.id).toBe("claude-haiku-4-5");
	});

	it("tierWithFallback walks down to strong->balanced->fast when missing", () => {
		const r = resolveTiers([model("anthropic", "claude-haiku-4-5")], DEFAULTS);
		expect(tierWithFallback(r.tiers, "strong")?.model.id).toBe("claude-haiku-4-5");
	});
});

describe("findExplicitModel", () => {
	const models: RegistryLikeModel[] = [
		model("anthropic", "claude-haiku-4-5"),
		model("openai", "gpt-4o-mini"),
	];

	it("returns model when present", () => {
		const r = findExplicitModel(models, "openai/gpt-4o-mini", false, []);
		expect("error" in r).toBe(false);
		if (!("error" in r)) {
			expect(r.id).toBe("gpt-4o-mini");
			expect(r.provider).toBe("openai");
		}
	});

	it("errors when missing and allow_unregistered=false", () => {
		const r = findExplicitModel(models, "anthropic/claude-haiku-9-9", false, []);
		expect("error" in r).toBe(true);
	});

	it("accepts unregistered when allowed", () => {
		const r = findExplicitModel(models, "anthropic/claude-haiku-9-9", true, []);
		expect("error" in r).toBe(false);
	});

	it("rejects ids outside allowed_models whitelist", () => {
		const r = findExplicitModel(models, "openai/gpt-4o-mini", false, ["anthropic/claude-haiku-4-5"]);
		expect("error" in r).toBe(true);
	});
});
