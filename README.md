# pi-web

`web_search` and `web_fetch` tools for the [pi coding agent](https://github.com/earendil-works/pi),
running on your Anthropic Claude subscription — the same OAuth bearer
and the same server-side tools Claude Code uses, with the knobs Claude
Code locks down exposed as per-call parameters.

## What this is

pi-web gives the main agent in a pi session two LLM-callable tools.
`web_search` invokes Anthropic's server-side `web_search_20250305` tool
through pi's already-authenticated bearer. `web_fetch` retrieves a
specific URL, either client-side (HTTP GET, Mozilla Readability +
Turndown for HTML, pdf.js for PDFs, optional side-channel summarization)
or through Anthropic's server-side `web_fetch_20250910` tool with
citation continuity replayed from a prior `web_search`.

Auth parity with Claude Code is the hook: no extra API keys, no
separate billing surface, the same wire shape on the same endpoint.
The divergence is the control surface. Claude Code hardcodes the
orchestrator model, the side-channel system prompt, and the thinking
budget; it does not let domain filters through; it does not let you
swap the summarizer to a different provider. pi-web surfaces all of
that as per-call arguments, layered config, and slash commands.

## Install

From npm via pi:

```bash
pi install npm:@boti-ormandi/pi-web
```

For local development, point pi at a checkout:

```json
{
	"extensions": ["/absolute/path/to/pi-web"]
}
```

Save in `~/.pi/agent/settings.json` (global) or `.pi/settings.json`
(per-project), then reload pi (`/reload`) or restart. Run `/web-models`
to confirm the tier mapping resolved against pi's registry.

The extension self-documents to the main agent via system-prompt
guidelines registered alongside each tool — you do not need to add a
copy-paste block to `AGENTS.md`. Add overrides there only when you
want to change the default behavior (e.g. "prefer `summary_tier:
strong` for this project").

## Tools

### `web_search`

Use for "what URLs are relevant" queries. Returns up to 10 titles,
URLs, and snippets via Anthropic's server-side `web_search` tool.
The encrypted citation token from each result is kept in
`details.results[].encryptedContent` (not sent to the LLM) so a
follow-up `web_fetch` with `backend: "server"` can replay it for
URL-provenance.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `query` | string | — | Required. |
| `max_results` | integer 1-20 | 10 | Sliced from Anthropic's fixed 10-result return. |
| `allowed_domains` | string[] | — | Appended to the orchestrator prompt. |
| `blocked_domains` | string[] | — | Appended to the orchestrator prompt. |
| `tier` | `fast` \| `balanced` \| `strong` | `fast` | Wins over config, loses to `orchestrator_model`. |
| `orchestrator_model` | `provider/id` | — | Anthropic-only. Overrides tier. |
| `include_synthesis` | boolean | `false` | Append the orchestrator's free-text summary. |
| `bypass_cache` | boolean | `false` | Skip cache lookup. |

### `web_fetch`

Use for "what does this specific page say" queries. Three modes:

- `raw` (default if no `prompt`) — fetch, HTML/PDF to markdown, return
  up to `raw_max_bytes`. No model call.
- `summary` (default if `prompt` given) — fetch, extract, side-channel
  summarization with the resolved summarizer.
- `auto` — pick by presence of `prompt`.

| Parameter | Type | Default | Notes |
|---|---|---|---|
| `url` | string | — | Required. http(s) only by default. |
| `prompt` | string | — | Extraction instructions; switches mode to `summary`. |
| `mode` | `raw` \| `summary` \| `auto` | derived from `prompt` | — |
| `summary_tier` | `fast` \| `balanced` \| `strong` | `balanced` | — |
| `summary_model` | `provider/id` | — | Any provider pi can authenticate. Overrides tier. |
| `thinking_budget` | integer 1024-32000 | none | Silently dropped on non-reasoning models. |
| `answer_max_tokens` | integer 256-16000 | 4000 | Summary output budget. |
| `raw_max_bytes` | integer >= 1024 | 65536 | Cap for raw mode. |
| `backend` | `client` \| `server` | `client` | `server` routes through Anthropic's server-side `web_fetch`. |
| `max_content_tokens` | integer 1024-200000 | 100000 | `server` only. Caps Anthropic's pre-truncation. |
| `require_fetch` | boolean | `true` | `server` only. Errors if the orchestrator skipped the tool. |
| `bypass_cache` | boolean | `false` | Skip cache lookup. |

LLM-facing output is a small header (final URL, title, model, truncation
note) followed by the cleaned markdown or summary. PDF page boundaries
are preserved as `## Page N` headings so the agent can cite by page.

## Tier-based model selection

`fast` / `balanced` / `strong` resolve against pi's model registry at
session start. The default tier configs ask for the newest model in
each family (newest version wins, with the dateless alias preferred
over a dated id). At time of writing those resolve to
`anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-4-6`, and
`anthropic/claude-opus-4-7`; the resolution updates automatically as
pi's registry changes. Use `/web-models` to see what your session
resolved.

To pin a tier to a specific model, replace the `{ "auto": ... }` value
with a string id, e.g. `"balanced": "anthropic/claude-sonnet-4-6"`.

## Configuration

Layered, last wins:

1. Defaults (`src/config/defaults.ts`).
2. `~/.pi/agent/extensions/pi-web/config.json` (global).
3. `.pi/pi-web.json` (per-project).
4. Environment variables.
5. CLI flags.
6. Per-call tool arguments.

Example `.pi/pi-web.json`:

```json
{
	"models": {
		"tiers": {
			"fast": { "auto": "latest-haiku" },
			"balanced": { "auto": "latest-sonnet" },
			"strong": { "auto": "latest-opus" }
		}
	},
	"search": { "tier": "fast", "include_synthesis": false },
	"fetch": {
		"summary_tier": "balanced",
		"raw_max_bytes": 65536,
		"user_agent_contact": "https://example.com/contact"
	},
	"cache": { "enabled": true, "ttl_seconds": 900, "persist_to_disk": false },
	"display": { "show_cost": "always" }
}
```

Environment variables:

| Variable | Effect |
|---|---|
| `PI_WEB_SEARCH_TIER` | `fast` / `balanced` / `strong` for `web_search`. |
| `PI_WEB_FETCH_TIER` | Default summarizer tier for `web_fetch`. |
| `PI_WEB_SUMMARY_MODEL` | Pin balanced tier to `provider/id`. |
| `PI_WEB_THINKING_BUDGET` | Default thinking budget on `web_fetch`. |
| `PI_WEB_CACHE_TTL` | Cache entry TTL in seconds. |
| `PI_WEB_USER_AGENT_CONTACT` | Contact URL embedded in `User-Agent`. |
| `PI_WEB_DISABLE_CACHE` | `1` or `true` disables the cache. |

CLI flags (set on pi launch):

- `--web-no-cache` — disable cache for the session.
- `--web-summary-model <provider/id>` — pin balanced tier.
- `--web-debug` — pi-web debug logging for the session.

`display.show_cost` controls whether the result renderer shows
estimated dollar cost: `always` (default), `debug` (only when debug
mode is on), `never`.

## Cross-provider summarizers

`web_fetch summary` mode routes by provider. Anthropic stays on
pi-web's hand-rolled `/v1/messages` path (SDK preamble at position 0,
OAuth beta header) so the auth-layer gate is satisfied. Any other
provider pi can authenticate to (OpenAI, Google, Bedrock, etc.) routes
through `pi-ai`'s `completeSimple`, picking up the same API-key
resolution the rest of pi uses.

Pin a non-Anthropic summarizer three ways:

```bash
export PI_WEB_SUMMARY_MODEL="openai/gpt-5-mini"
```

```bash
pi --web-summary-model openai/gpt-5-mini
```

```json
{ "summary_model": "openai/gpt-5-mini", "prompt": "..." }
```

`web_search` stays Anthropic-only — it depends on Anthropic's
server-side `web_search` tool. Tier and model overrides on `web_search`
resolve against Anthropic models only.

## Server-side fetch backend

`backend: "server"` routes the fetch through Anthropic's server-side
`web_fetch_20250910` tool instead of the client-side pipeline. The
reason to use it is citation continuity: if the URL came from a recent
`web_search`, pi-web replays that prior assistant turn (the
`server_tool_use` + `web_search_tool_result` blocks with their opaque
`encrypted_content`) into the request so Anthropic's URL-provenance
check links the fetch to the originating search.

It costs an orchestrator turn — there is no `raw` mode under server
backend, and `thinking_budget` is not supported. By default
`require_fetch: true` errors with a recoverable message if the
orchestrator answers from prior knowledge instead of actually invoking
the tool. Set `require_fetch: false` to accept skips (a clear skip-note
is prepended to the result).

## Persistent cache

The in-memory LRU+TTL cache can be persisted to disk by setting
`cache.persist_to_disk: true`. Entries are stored as one JSON file per
key under `~/.pi/agent/extensions/pi-web/cache/` and survive `/reload`
and process restart. Corrupt files are skipped on load; write failures
surface as a one-shot UI warning, never as a tool-call failure.

## Security defaults

All configurable under `security.*` and `fetch.*`:

- No `file://` URLs.
- No private IP space (RFC 1918, loopback, link-local, cloud metadata).
- Response size cap (`fetch.max_response_bytes`, default 10 MB).
- Request timeout (`fetch.request_timeout_ms`, default 30s).
- Redirect chain re-validated against scheme, IP, and domain rules at
  each hop (`fetch.max_redirects`, default 5).
- Identifying `User-Agent: pi-web/<version> (+<contact>)`.

## Slash commands

- `/web-config` — open resolved config in `$EDITOR`; subcommands
  `show` (print resolved + sources) and `where` (print config paths).
- `/web-models` — show the resolved tier mapping and the Anthropic
  models pi's registry exposes.
- `/web-cache` — `stats` (default), `list`, `clear`, `clear-expired`.
- `/web-debug` — toggle pi-web debug logging for the session
  (`on`, `off`, or no-arg toggle).

## Errors the LLM may see

| Failure | Surfaced as |
|---|---|
| `web_search` geo restriction | "Anthropic web_search is US-only..." |
| 429 rate limit | "Anthropic rate-limited. Reset window: ..." |
| 401 auth | "Anthropic auth failed; run `/login`" |
| Model id rejected | "Anthropic rejected model id ... pi's registry may need updating" |
| Bad URL / network | "Could not reach <host>: <reason>" |
| Response too big | "Response declared content-length ... exceeds max_response_bytes" |
| Server-fetch skipped (`require_fetch: true`) | "Anthropic's orchestrator skipped web_fetch for <url> and answered from prior knowledge..." |
| Thinking on non-reasoning model | Silently stripped; `details.thinkingUnavailable = true` |

## Development

```bash
npm install
npm test
```

`npm test` runs the vitest suite (104 tests): config layering, tier
auto-resolution, URL safety, HTML and PDF extraction, the cache's LRU
and TTL behavior, the citation-context cache, and the server-side
`web_fetch` response parser. Live integration against Anthropic is
not in the unit suite — it would burn the bearer's rate-limit budget
on CI.

## License

MIT. See [LICENSE](./LICENSE).
