import { describe, expect, it } from "vitest";
import { thinkingBudgetToLevel } from "../src/auth/provider-router.js";

describe("thinkingBudgetToLevel", () => {
	it("returns undefined for missing / sub-minimum budgets", () => {
		expect(thinkingBudgetToLevel(undefined)).toBeUndefined();
		expect(thinkingBudgetToLevel(0)).toBeUndefined();
		expect(thinkingBudgetToLevel(500)).toBeUndefined();
	});

	it("maps 1024..3999 to low", () => {
		expect(thinkingBudgetToLevel(1024)).toBe("low");
		expect(thinkingBudgetToLevel(3999)).toBe("low");
	});

	it("maps 4000..7999 to medium", () => {
		expect(thinkingBudgetToLevel(4000)).toBe("medium");
		expect(thinkingBudgetToLevel(7999)).toBe("medium");
	});

	it("maps 8000..15999 to high", () => {
		expect(thinkingBudgetToLevel(8000)).toBe("high");
		expect(thinkingBudgetToLevel(15999)).toBe("high");
	});

	it("maps 16000+ to xhigh", () => {
		expect(thinkingBudgetToLevel(16000)).toBe("xhigh");
		expect(thinkingBudgetToLevel(32000)).toBe("xhigh");
	});
});
