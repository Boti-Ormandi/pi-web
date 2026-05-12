import { describe, expect, it } from "vitest";
import { checkUrl, domainAllowed, isPrivateOrSpecialHost, parseUrl } from "../src/fetch/url-safety.js";

const SAFE = { allowFileUrls: false, allowPrivateIps: false };
const PERMISSIVE = { allowFileUrls: true, allowPrivateIps: true };

describe("parseUrl", () => {
	it("returns null for nonsense", () => {
		expect(parseUrl("not a url")).toBeNull();
	});
	it("parses http(s) URLs", () => {
		expect(parseUrl("https://example.com/x")?.host).toBe("example.com");
	});
});

describe("isPrivateOrSpecialHost", () => {
	it("blocks localhost and loopback", () => {
		expect(isPrivateOrSpecialHost("localhost")).toBe(true);
		expect(isPrivateOrSpecialHost("127.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialHost("::1")).toBe(true);
	});
	it("blocks RFC1918 ipv4 ranges", () => {
		expect(isPrivateOrSpecialHost("10.0.0.1")).toBe(true);
		expect(isPrivateOrSpecialHost("192.168.1.1")).toBe(true);
		expect(isPrivateOrSpecialHost("172.16.0.5")).toBe(true);
		expect(isPrivateOrSpecialHost("172.31.255.254")).toBe(true);
	});
	it("blocks cloud metadata endpoints", () => {
		expect(isPrivateOrSpecialHost("169.254.169.254")).toBe(true);
		expect(isPrivateOrSpecialHost("metadata.google.internal")).toBe(true);
	});
	it("blocks ULA and link-local IPv6", () => {
		expect(isPrivateOrSpecialHost("fd00::1")).toBe(true);
		expect(isPrivateOrSpecialHost("fe80::1")).toBe(true);
	});
	it("allows real public IPs", () => {
		expect(isPrivateOrSpecialHost("8.8.8.8")).toBe(false);
		expect(isPrivateOrSpecialHost("example.com")).toBe(false);
	});
});

describe("checkUrl", () => {
	it("rejects file:// by default", () => {
		const r = checkUrl("file:///etc/passwd", SAFE);
		expect(r.ok).toBe(false);
	});
	it("allows file:// when opted in", () => {
		const r = checkUrl("file:///etc/passwd", PERMISSIVE);
		expect(r.ok).toBe(true);
	});
	it("rejects unsupported schemes", () => {
		const r = checkUrl("ftp://example.com/x", SAFE);
		expect(r.ok).toBe(false);
	});
	it("rejects private IP targets by default", () => {
		const r = checkUrl("http://10.0.0.1/", SAFE);
		expect(r.ok).toBe(false);
	});
	it("rejects metadata endpoint", () => {
		const r = checkUrl("http://169.254.169.254/", SAFE);
		expect(r.ok).toBe(false);
	});
	it("accepts public HTTPS", () => {
		const r = checkUrl("https://example.com/path", SAFE);
		expect(r.ok).toBe(true);
	});
	it("rejects invalid URLs", () => {
		const r = checkUrl("not a url", SAFE);
		expect(r.ok).toBe(false);
	});
});

describe("domainAllowed", () => {
	it("blocks beats allow when both match", () => {
		expect(domainAllowed("example.com", ["example.com"], ["example.com"])).toBe(false);
	});
	it("subdomain match works", () => {
		expect(domainAllowed("docs.example.com", ["example.com"], [])).toBe(true);
		expect(domainAllowed("docs.example.com", [], ["example.com"])).toBe(false);
	});
	it("wildcard prefix accepted", () => {
		expect(domainAllowed("docs.example.com", ["*.example.com"], [])).toBe(true);
	});
	it("empty allow-list permits everything not in block-list", () => {
		expect(domainAllowed("example.com", [], [])).toBe(true);
	});
});
