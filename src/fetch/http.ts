import { USER_AGENT } from "../config/defaults.js";
import { checkUrl, type UrlSafetyOptions } from "./url-safety.js";

export interface HttpFetchOptions extends UrlSafetyOptions {
	maxResponseBytes: number;
	requestTimeoutMs: number;
	maxRedirects: number;
	followRedirects: boolean;
	userAgentContact: string;
	signal?: AbortSignal;
	onProgress?: (msg: string) => void;
}

export interface HttpFetchResult {
	ok: true;
	finalUrl: string;
	status: number;
	contentType: string;
	contentLength: number;
	body: Uint8Array;
	truncated: boolean;
	redirectChain: string[];
}

export interface HttpFetchError {
	ok: false;
	reason: string;
	finalUrl?: string;
	status?: number;
}

export type HttpFetchOutcome = HttpFetchResult | HttpFetchError;

const ACCEPT_HEADER =
	"text/markdown, text/html, application/xhtml+xml, text/plain;q=0.9, application/json;q=0.9, */*;q=0.1";

function combineSignals(signals: (AbortSignal | undefined)[]): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const live = signals.filter((s): s is AbortSignal => s !== undefined);
	if (live.some((s) => s.aborted)) {
		controller.abort();
		return { signal: controller.signal, cleanup: () => {} };
	}
	const handlers: Array<{ s: AbortSignal; h: () => void }> = [];
	for (const s of live) {
		const h = () => controller.abort();
		s.addEventListener("abort", h, { once: true });
		handlers.push({ s, h });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			for (const { s, h } of handlers) s.removeEventListener("abort", h);
		},
	};
}

async function readWithCap(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<{ data: Uint8Array; truncated: boolean }> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		if (!value) continue;
		if (total + value.byteLength > maxBytes) {
			const remaining = maxBytes - total;
			if (remaining > 0) chunks.push(value.subarray(0, remaining));
			total += remaining;
			truncated = true;
			try {
				await reader.cancel();
			} catch {
				// ignore
			}
			break;
		}
		chunks.push(value);
		total += value.byteLength;
	}
	const data = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		data.set(c, offset);
		offset += c.byteLength;
	}
	return { data, truncated };
}

export async function httpFetch(initialUrl: string, opts: HttpFetchOptions): Promise<HttpFetchOutcome> {
	const initial = checkUrl(initialUrl, opts);
	if (!initial.ok) return { ok: false, reason: initial.reason };

	const headers: Record<string, string> = {
		"User-Agent": USER_AGENT(opts.userAgentContact),
		Accept: ACCEPT_HEADER,
		"Accept-Language": "en;q=0.9, *;q=0.5",
	};

	const timeoutController = new AbortController();
	const timeoutId = setTimeout(() => timeoutController.abort(), opts.requestTimeoutMs);
	const combined = combineSignals([opts.signal, timeoutController.signal]);

	const redirectChain: string[] = [];
	let currentUrl = initial.url.toString();

	try {
		for (let hop = 0; hop <= opts.maxRedirects; hop++) {
			const target = checkUrl(currentUrl, opts);
			if (!target.ok) return { ok: false, reason: target.reason, finalUrl: currentUrl };

			opts.onProgress?.(`Fetching ${target.url.host}${target.url.pathname}`);

			const res = await fetch(currentUrl, {
				method: "GET",
				redirect: "manual",
				signal: combined.signal,
				headers,
			});

			if (res.status >= 300 && res.status < 400) {
				const loc = res.headers.get("location");
				if (!loc || !opts.followRedirects) {
					return {
						ok: false,
						reason: `Redirect not followed (${res.status} -> ${loc ?? "no location"})`,
						finalUrl: currentUrl,
						status: res.status,
					};
				}
				if (hop === opts.maxRedirects) {
					return {
						ok: false,
						reason: `Exceeded max_redirects (${opts.maxRedirects})`,
						finalUrl: currentUrl,
						status: res.status,
					};
				}
				const resolved = new URL(loc, currentUrl).toString();
				redirectChain.push(currentUrl);
				currentUrl = resolved;
				continue;
			}

			const contentType = res.headers.get("content-type") ?? "application/octet-stream";

			if (!res.ok) {
				let bodyExcerpt = "";
				try {
					const t = await res.text();
					bodyExcerpt = t.slice(0, 300);
				} catch {
					// ignore
				}
				return {
					ok: false,
					reason: `HTTP ${res.status} from ${target.url.host}: ${bodyExcerpt || res.statusText}`,
					finalUrl: currentUrl,
					status: res.status,
				};
			}

			const declaredLength = Number(res.headers.get("content-length") ?? "0");
			if (Number.isFinite(declaredLength) && declaredLength > opts.maxResponseBytes) {
				return {
					ok: false,
					reason: `Response declared content-length ${declaredLength} exceeds max_response_bytes ${opts.maxResponseBytes}`,
					finalUrl: currentUrl,
					status: res.status,
				};
			}

			if (!res.body) {
				return {
					ok: true,
					finalUrl: currentUrl,
					status: res.status,
					contentType,
					contentLength: 0,
					body: new Uint8Array(0),
					truncated: false,
					redirectChain,
				};
			}

			const { data, truncated } = await readWithCap(res.body, opts.maxResponseBytes);
			return {
				ok: true,
				finalUrl: currentUrl,
				status: res.status,
				contentType,
				contentLength: data.byteLength,
				body: data,
				truncated,
				redirectChain,
			};
		}

		return { ok: false, reason: "Exhausted redirect loop without a final response", finalUrl: currentUrl };
	} catch (err) {
		if (combined.signal.aborted && opts.signal?.aborted) {
			return { ok: false, reason: "Cancelled by user", finalUrl: currentUrl };
		}
		if (combined.signal.aborted) {
			return { ok: false, reason: `Request timed out after ${opts.requestTimeoutMs}ms`, finalUrl: currentUrl };
		}
		return {
			ok: false,
			reason: `Network error: ${err instanceof Error ? err.message : String(err)}`,
			finalUrl: currentUrl,
		};
	} finally {
		clearTimeout(timeoutId);
		combined.cleanup();
	}
}
