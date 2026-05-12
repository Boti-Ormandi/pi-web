import { createHash } from "node:crypto";

/**
 * Canonicalize a value (deterministic key ordering, undefineds dropped)
 * and return a sha256 hex digest of the JSON.
 */
export function stableHash(value: unknown): string {
	return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) {
		return "[" + value.map(canonicalize).join(",") + "]";
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
		return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
	}
	return JSON.stringify(String(value));
}
