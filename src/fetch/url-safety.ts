import { isIP } from "node:net";

export interface UrlSafetyOptions {
	allowFileUrls: boolean;
	allowPrivateIps: boolean;
}

export type UrlCheckResult =
	| { ok: true; url: URL }
	| { ok: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export function parseUrl(input: string): URL | null {
	try {
		return new URL(input);
	} catch {
		return null;
	}
}

/**
 * Block obvious internal-network targets when `allow_private_ips` is off.
 */
export function isPrivateOrSpecialHost(host: string): boolean {
	const h = host.toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost")) return true;
	if (h === "metadata" || h.endsWith(".internal") || h.endsWith(".local")) return true;
	if (h === "metadata.google.internal") return true;

	const v = isIP(h);
	if (v === 0) return false;

	if (v === 4) return isPrivateIPv4(h);
	if (v === 6) return isPrivateIPv6(h);
	return false;
}

function isPrivateIPv4(ip: string): boolean {
	const parts = ip.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
		return false;
	}
	const [a, b] = parts as [number, number, number, number];
	if (a === 10) return true;
	if (a === 127) return true;
	if (a === 0) return true;
	if (a === 169 && b === 254) return true; // link-local + AWS/GCP metadata
	if (a === 172 && b >= 16 && b <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a >= 224 && a <= 239) return true; // multicast
	if (a >= 240) return true; // reserved
	return false;
}

function isPrivateIPv6(ip: string): boolean {
	const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
	if (h === "::1" || h === "::") return true;
	if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7
	if (h.startsWith("fe80:")) return true; // link-local
	if (h.startsWith("ff")) return true; // multicast
	// IPv4-mapped: ::ffff:x.x.x.x
	const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (mapped) return isPrivateIPv4(mapped[1]!);
	return false;
}

export function checkUrl(input: string, opts: UrlSafetyOptions): UrlCheckResult {
	const url = parseUrl(input);
	if (!url) return { ok: false, reason: `Invalid URL: ${input}` };

	if (url.protocol === "file:") {
		if (!opts.allowFileUrls) {
			return { ok: false, reason: "file:// URLs are blocked by default (set security.allow_file_urls to override)" };
		}
		return { ok: true, url };
	}

	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		return { ok: false, reason: `Unsupported URL scheme: ${url.protocol}` };
	}

	if (!url.hostname) return { ok: false, reason: "URL has no host" };

	if (!opts.allowPrivateIps && isPrivateOrSpecialHost(url.hostname)) {
		return {
			ok: false,
			reason: `Refusing to fetch host ${url.hostname} (private/internal address; set security.allow_private_ips to override)`,
		};
	}

	return { ok: true, url };
}

export function domainAllowed(host: string, allowed: readonly string[], blocked: readonly string[]): boolean {
	const h = host.toLowerCase();
	if (blocked.some((d) => matchDomain(h, d))) return false;
	if (allowed.length === 0) return true;
	return allowed.some((d) => matchDomain(h, d));
}

function matchDomain(host: string, pattern: string): boolean {
	const p = pattern.toLowerCase().replace(/^\*\.?/, "");
	return host === p || host.endsWith(`.${p}`);
}
