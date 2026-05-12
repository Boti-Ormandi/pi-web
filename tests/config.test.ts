import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULTS } from "../src/config/defaults.js";
import { loadConfig } from "../src/config/loader.js";

describe("config loader", () => {
	let workDir = "";
	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), "pi-web-cfg-"));
	});
	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	it("returns defaults when no config files exist", () => {
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: join(workDir, "missing-global.json"),
			projectConfigPath: join(workDir, "missing-project.json"),
		});
		expect(r.config).toEqual(DEFAULTS);
		expect(r.sources.map((s) => s.label)).toEqual(["defaults"]);
	});

	it("merges global config over defaults", () => {
		const globalPath = join(workDir, "global.json");
		writeFileSync(
			globalPath,
			JSON.stringify({
				search: { tier: "strong" },
				cache: { ttl_seconds: 60 },
			}),
		);
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: globalPath,
			projectConfigPath: join(workDir, "missing.json"),
		});
		expect(r.config.search.tier).toBe("strong");
		expect(r.config.cache.ttl_seconds).toBe(60);
		// Untouched keys keep defaults.
		expect(r.config.search.default_max_results).toBe(DEFAULTS.search.default_max_results);
	});

	it("project config wins over global", () => {
		const globalPath = join(workDir, "global.json");
		const projectPath = join(workDir, "project.json");
		writeFileSync(globalPath, JSON.stringify({ search: { tier: "strong" } }));
		writeFileSync(projectPath, JSON.stringify({ search: { tier: "fast" } }));
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: globalPath,
			projectConfigPath: projectPath,
		});
		expect(r.config.search.tier).toBe("fast");
		expect(r.sources.map((s) => s.label)).toContain("project");
		expect(r.sources.map((s) => s.label)).toContain("global");
	});

	it("env vars override files", () => {
		const globalPath = join(workDir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ fetch: { summary_tier: "balanced" } }));
		const r = loadConfig({
			cwd: workDir,
			env: {
				PI_WEB_FETCH_TIER: "strong",
				PI_WEB_THINKING_BUDGET: "8000",
				PI_WEB_DISABLE_CACHE: "1",
			},
			globalConfigPath: globalPath,
			projectConfigPath: join(workDir, "missing.json"),
		});
		expect(r.config.fetch.summary_tier).toBe("strong");
		expect(r.config.fetch.thinking_budget).toBe(8000);
		expect(r.config.cache.enabled).toBe(false);
	});

	it("PI_WEB_SUMMARY_MODEL pins the balanced tier", () => {
		const r = loadConfig({
			cwd: workDir,
			env: { PI_WEB_SUMMARY_MODEL: "anthropic/claude-haiku-4-5" },
			globalConfigPath: join(workDir, "missing-g.json"),
			projectConfigPath: join(workDir, "missing-p.json"),
		});
		expect(r.config.models.tiers.balanced).toBe("anthropic/claude-haiku-4-5");
		// fast/strong stay auto.
		expect(r.config.models.tiers.fast).toEqual({ auto: "latest-haiku" });
		expect(r.config.models.tiers.strong).toEqual({ auto: "latest-opus" });
	});

	it("rejects invalid tier values silently", () => {
		const globalPath = join(workDir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ search: { tier: "extreme" } }));
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: globalPath,
			projectConfigPath: join(workDir, "missing.json"),
		});
		expect(r.config.search.tier).toBe(DEFAULTS.search.tier);
	});

	it("survives malformed JSON without throwing", () => {
		const globalPath = join(workDir, "global.json");
		mkdirSync(workDir, { recursive: true });
		writeFileSync(globalPath, "{ not valid json");
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: globalPath,
			projectConfigPath: join(workDir, "missing.json"),
		});
		expect(r.config).toEqual(DEFAULTS);
		const errSource = r.sources.find((s) => s.label.includes("error"));
		expect(errSource).toBeDefined();
	});

	it("clamps default_max_results into 1..20", () => {
		const projectPath = join(workDir, "project.json");
		writeFileSync(projectPath, JSON.stringify({ search: { default_max_results: 999 } }));
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: join(workDir, "missing.json"),
			projectConfigPath: projectPath,
		});
		expect(r.config.search.default_max_results).toBe(20);
	});

	it("CLI --web-no-cache wins over env and config", () => {
		const globalPath = join(workDir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ cache: { enabled: true } }));
		const r = loadConfig({
			cwd: workDir,
			env: {},
			globalConfigPath: globalPath,
			projectConfigPath: join(workDir, "missing.json"),
			cliFlags: { noCache: true },
		});
		expect(r.config.cache.enabled).toBe(false);
		expect(r.sources.map((s) => s.label)).toContain("cli");
	});

	it("CLI --web-summary-model pins balanced tier and wins over env", () => {
		const r = loadConfig({
			cwd: workDir,
			env: { PI_WEB_SUMMARY_MODEL: "anthropic/claude-opus-4-7" },
			globalConfigPath: join(workDir, "missing-g.json"),
			projectConfigPath: join(workDir, "missing-p.json"),
			cliFlags: { summaryModel: "anthropic/claude-haiku-4-5" },
		});
		expect(r.config.models.tiers.balanced).toBe("anthropic/claude-haiku-4-5");
	});
});
