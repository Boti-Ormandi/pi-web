# Changelog

All notable changes to pi-web are recorded here.

## [0.3.1]

- Renderer no longer prints the bold `WebSearch ` / `WebFetch ` header
  twice on settled tool rows. The tool-execution row composes
  `renderCall` and `renderResult` into the same container; both slots
  were emitting the tool name, so a settled row showed two stacked
  bold headers. The result-line head now leads with the outcome
  (`5 results` / `summary` / `raw` / `summary [server·cite]`) and lets
  the call slot above carry the tool name. Matches the precedent set
  by built-in `bash` (call: `$ <cmd>`, result: just output and timing).
- Unified head structure between `web_search` and `web_fetch` settled
  rows: `<outcome>  [middle]  <model> (cached) (elapsed) [cost]`,
  built by joining a filtered segments array. `(cached)` and
  `(elapsed)` sit in the same column in both tools.
- `web_fetch` raw mode no longer renders a misleading `raw` token in
  the model slot; the mode is already shown to the left as the
  outcome.
- `web_fetch` call line uses a parts-array pattern so an empty flag
  list no longer leaves trailing whitespace.
- `web_fetch` expanded preview shows the page body, not the
  `Fetched: ...` / `Title: ...` / `Summarized via ...` lines that
  already appear above as structured fields. New `extractFetchBody`
  helper splits on the `\n\n---\n\n` divider (raw and server modes) or
  the first blank line (summary mode); server-mode pre-header
  skip-note is correctly skipped along with the structured header.
- `web_fetch` expanded view no longer prints a redundant `Cache: hit`
  line. The collapsed head already shows `(cached)`.
- `web_search` in-band `web_search_tool_result_error` codes
  (`too_many_requests`, `invalid_input`, `max_uses_exceeded`,
  `query_too_long`, `unavailable`) are mapped to friendlier labels.
  Unknown codes fall through to the raw code.
- `web_search` expanded view now shows the `Usage: in=N out=M` line,
  matching what `web_fetch` already displayed.

## [0.3.0]

- Server-side `web_fetch` skip detection. The orchestrator may answer
  from prior knowledge instead of invoking the declared
  `web_fetch_20250910` tool. `WebFetchDetails` gains
  `serverFetchInvoked: boolean`, derived from the presence of a
  `web_fetch_tool_result` block in the response. New schema param
  `require_fetch?: boolean` (default `true`, server-only): on skip,
  pi-web throws a recoverable error pointing the caller at three
  remediations (more specific prompt, switch to `backend: "client"`,
  or `require_fetch: false`). Soft mode (`require_fetch: false`)
  returns the prior-knowledge answer with a skip-note prepended.
  Neither skips nor server-side errors are cached.
  `buildServerFetchMessages` uses imperative wording ("Use your
  web_fetch tool... Do not answer from prior knowledge") in both the
  citation and no-citation paths. Fetch renderer surfaces a
  `[server·skipped]` warning tag (collapsed) and a `Fetch invoked: no`
  row (expanded).
- Server-side `web_fetch` backend (`backend: "server"`). Routes the fetch
  through Anthropic's server-side `web_fetch_20250910` tool instead of
  the client-side GET + Readability + Turndown pipeline. The motivation
  is citation continuity with `web_search`: pi-web maintains an
  in-memory `CitationContextCache` keyed by URL that records the prior
  `web_search` assistant turn (server_tool_use + web_search_tool_result
  with their opaque encrypted_content blobs); on server-mode fetch the
  cached turn is replayed into the `/v1/messages` body so Anthropic's
  server-side URL-provenance check links the fetch to the originating
  search. Surfaces `details.backend`, `details.citationLinked`,
  `details.citationQuery`, `details.retrievedAt`,
  `details.serverFetchErrorCode`, and `details.maxContentTokens`.
  Server backend is anthropic-only, has no `raw` mode (server-side
  always pays for an orchestrator turn), and does not support
  `thinking_budget`.
- `max_results` on `web_search` is now actually enforced. Anthropic's
  server-side tool always returns 10; we now slice the parsed results
  to the caller's `max_results` cap before they reach the LLM or
  `details.results`.
- Citation-context cache is in-memory only; encrypted_content blobs from
  `web_search` results are never persisted to disk.
- Fetch cache key includes `backend` and `maxContentTokens` so client and
  server results never alias on the same URL+prompt.
- Fetch renderer surfaces `[server]` / `[server·cite]` tag in the
  collapsed header and Backend / Citation / Retrieved / max_content_tokens
  / Server error rows in the expanded view.
- PDF extraction in `web_fetch`. PDFs at any reachable URL flow through
  Mozilla pdf.js (via `pdfjs-dist`) instead of being rejected with a
  deferred-feature note. Output is page-segmented as `## Page N` headings
  so the agent can cite by page. PDF metadata (`Title`, `Author`) is
  promoted to `pageTitle` / `byline`.
- `WebFetchDetails` gains `contentKind` and `pageCount`; the expanded
  fetch renderer surfaces "Kind: PDF (12 pages)".
- `extractContent` is now async to accommodate PDF parsing.

## [0.2.0]

- CLI flags: `--web-no-cache`, `--web-summary-model <provider/id>`,
  `--web-debug`. Layered above env vars, below per-call args.
- Cross-provider summarizer routing for `web_fetch summary` mode.
  Anthropic stays on the hand-rolled `/v1/messages` path; OpenAI /
  Google / Bedrock / etc. route through pi-ai's `completeSimple`,
  picking up the same API-key resolution the rest of pi uses.
- Disk-persistent cache (opt-in via `cache.persist_to_disk`). Entries
  survive `/reload` and process restart; corrupt files are silently
  skipped on load.
- New slash commands: `/web-cache` (stats, list, clear, clear-expired)
  and `/web-debug` (toggle).
- `MemoryCache` gained `setPersistence(hook)` and `restore(entries)`
  for write-through to external stores.
- README documents the cross-provider section and the persistent
  cache section.

## [0.1.0]

- `web_search` tool: orchestrator-based search via Anthropic's server-side
  `web_search` tool. Supports `tier` (`fast` / `balanced` / `strong`),
  `orchestrator_model` escape hatch, domain filters, configurable result
  count, optional synthesis text.
- `web_fetch` tool: `raw` / `summary` / `auto` modes. HTML→markdown via
  Readability + Turndown. Optional side-channel summarization with
  per-call `summary_tier` / `summary_model` / `thinking_budget`.
- Tier auto-resolution against `ctx.modelRegistry` (newest version wins,
  alias preferred over dated id).
- Three-layer config: defaults -> `~/.pi/agent/extensions/pi-web/config.json`
  / `.pi/pi-web.json` -> env vars -> per-call tool args.
- In-memory LRU+TTL cache.
- URL safety: no `file://`, no private IP space, redirect re-check,
  response size cap, request timeout.
- Custom renderers with optional cost display.
- Slash commands `/web-config`, `/web-models`.
- System-prompt integration via `promptSnippet` + `promptGuidelines`.
