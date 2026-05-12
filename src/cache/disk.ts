import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { CacheEntry, CachePersistenceHook } from "./store.js";

export interface DiskCacheBackendOptions {
	/** Directory in which entry files live. Created if missing. */
	dir: string;
	/** Called when a persistence operation fails (e.g. disk full). Best-effort. */
	onError?: (err: Error, op: "write" | "delete" | "clear" | "load") => void;
}

interface SerializedEntry<T> {
	v: 1;
	key: string;
	createdAt: number;
	expiresAt: number;
	sizeBytes: number;
	tag: string;
	value: T;
}

function keyToFilename(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 32) + ".json";
}

/**
 * One-file-per-entry JSON-backed cache. Single-process; no locking.
 *
 * Mounted on a MemoryCache via `setPersistence(backend.toHook())`. Use
 * `loadAll()` once at startup to read existing entries and feed them into
 * the cache via `cache.restore()`.
 */
export class DiskCacheBackend<T> {
	private readonly dir: string;
	private readonly onError: (err: Error, op: "write" | "delete" | "clear" | "load") => void;

	constructor(opts: DiskCacheBackendOptions) {
		this.dir = resolve(opts.dir);
		this.onError = opts.onError ?? (() => {});
		try {
			mkdirSync(this.dir, { recursive: true });
		} catch (err) {
			this.onError(toError(err), "write");
		}
	}

	getDir(): string {
		return this.dir;
	}

	/**
	 * Read every entry file in the cache directory. Files that fail to parse
	 * are silently skipped (corruption is non-fatal). Expired entries are
	 * returned anyway; the caller's `cache.restore()` drops them.
	 */
	loadAll(): CacheEntry<T>[] {
		const out: CacheEntry<T>[] = [];
		if (!existsSync(this.dir)) return out;
		let files: string[] = [];
		try {
			files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
		} catch (err) {
			this.onError(toError(err), "load");
			return out;
		}
		for (const name of files) {
			const full = join(this.dir, name);
			try {
				const text = readFileSync(full, "utf8");
				const parsed = JSON.parse(text) as SerializedEntry<T>;
				if (!parsed || parsed.v !== 1 || typeof parsed.key !== "string") continue;
				out.push({
					key: parsed.key,
					createdAt: parsed.createdAt,
					expiresAt: parsed.expiresAt,
					sizeBytes: parsed.sizeBytes ?? 0,
					tag: parsed.tag ?? "",
					value: parsed.value,
				});
			} catch {
				// Corrupt entry: ignore. Don't onError -- a half-written file from a
				// prior crash is expected to surface here on next launch.
			}
		}
		return out;
	}

	write(entry: CacheEntry<T>): void {
		const serial: SerializedEntry<T> = {
			v: 1,
			key: entry.key,
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
			sizeBytes: entry.sizeBytes,
			tag: entry.tag,
			value: entry.value,
		};
		const full = join(this.dir, keyToFilename(entry.key));
		try {
			writeFileSync(full, JSON.stringify(serial), "utf8");
		} catch (err) {
			this.onError(toError(err), "write");
		}
	}

	remove(key: string): void {
		const full = join(this.dir, keyToFilename(key));
		try {
			if (existsSync(full)) unlinkSync(full);
		} catch (err) {
			this.onError(toError(err), "delete");
		}
	}

	clear(): void {
		try {
			if (!existsSync(this.dir)) return;
			for (const name of readdirSync(this.dir)) {
				if (!name.endsWith(".json")) continue;
				try {
					rmSync(join(this.dir, name), { force: true });
				} catch (err) {
					this.onError(toError(err), "clear");
				}
			}
		} catch (err) {
			this.onError(toError(err), "clear");
		}
	}

	toHook(): CachePersistenceHook<T> {
		return {
			onSet: (entry) => this.write(entry),
			onDelete: (key) => this.remove(key),
			onClear: () => this.clear(),
		};
	}
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

export function defaultCacheDir(): string {
	return resolve(homedir(), ".pi", "agent", "extensions", "pi-web", "cache");
}
