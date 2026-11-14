# PLAN.md

## Current

_(none)_

## Planned

_(none)_

## Done

### Phase: Readable modules, return checks, CORS, heartbeat, local dev — Done (2026-11-14)

**Goal:** From the second review: split `src/index.ts` by concept (10.1), check return
types like parameters (7), support cross-origin clients (8), keep idle streams alive (10.3),
and listen on localhost only in dev (10.4).

**Steps:**
- [x] Refactor into modules with no behaviour change; the existing suite passes unchanged
- [x] Tests first for each new behaviour below
- [x] Return and stream event types checked at startup with the parameter validator
- [x] `corsOrigins` option: preflight and response headers for listed origins only
- [x] Stream heartbeat comment; client ignores frames without data
- [x] `host` option; dev defaults to `127.0.0.1`
- [x] README, CLAUDE.md symlink (10.5)

**Done when:**
1. `npm run check` passes with the pre-refactor tests unchanged, after the refactor batch.
2. A function returning `Promise<Date>` (or a stream of `Date`) fails startup naming the method.
3. With `corsOrigins: [A]`, an `OPTIONS` preflight from origin A to `/gold_request` and
   `/gold_sse` gets 204 with `Access-Control-Allow-Origin: A`, `-Credentials: true`,
   `-Headers` including `X-Gold-Method`; responses to A carry the same origin header; an
   unlisted origin gets no CORS headers.
4. In a real browser, a page on origin A calls an API on origin B listed in `corsOrigins`
   through the generated client (call and stream); with B not listing A, the call fails.
5. An open stream receives `: ping` every `streamHeartbeatMs`; the generated client
   delivers no extra data for it.
6. `gild({ host: "127.0.0.1" })` listens on 127.0.0.1 only; dev mode does so by default.

**Decisions:**
- `corsOrigins: string[]` of exact origins, no wildcard. Allowed origins get
  `Access-Control-Allow-Credentials: true`, and the client always sends
  `credentials: "include"`, so cookie-based `authorize` works cross-origin. Unlisted origins
  get no CORS headers, so the `X-Gold-Method` cross-site guard still holds.
- Return types are checked at startup only (like parameters), not at runtime per call.
- Heartbeat default 15 s, option `streamHeartbeatMs`.
- `host` option; default `127.0.0.1` in dev, all interfaces otherwise.

**Validation:**
- Refactor batch: `src/index.ts` (1,190 lines) split into ten modules plus
  `src/clientRuntime.js`, by moving code unchanged. The 55 existing tests passed with no
  test edits (criterion 1).
- New tests written first and failing (the options did not exist): unsupported return
  types, CORS preflight and response headers, unlisted and absent origins, invalid
  `corsOrigins`, `host`, heartbeat.
- `npm run check`: `tsc --noEmit` clean; 64 tests, 64 pass, about 9 s (three runs).
- Criterion 4 in real browsers: a script run in the `janus-check` Playwright image (the
  repo mounted read-only) served a page on one origin calling, through the generated
  client, an API listing that origin and one that does not. Chromium, Firefox and WebKit
  all passed: call returned 3, stream gave [5, 6], unlisted API blocked ("Failed to fetch"
  / "NetworkError" / "Load failed"). The script lives outside the repo; it is not part of
  `npm run check`.
- Criterion 6 for dev mode is covered by the example's acceptance test: 127.0.0.1
  answers, the LAN address is refused.

**Hardening findings:**
- `corsOrigins` rejects `*`, trailing slashes and bare hosts at startup, because
  credentials cannot be combined with a wildcard and a near-miss would silently never
  match.
- `Vary: Origin` is set on every `/gold_*` response when CORS is on, so caches do not
  serve one origin's headers to another.
- Heartbeat timers are cleared on every exit path of a stream (end, error, disconnect).

**Limitations:**
- Dev in a container or VM now needs `host: "0.0.0.0"` to be reachable from outside it.
- The browser CORS check is a one-off script, not a repeatable test in this repo.

### Phase: Harden the API layer — Done (2026-11-14)

**Goal:** Close the cross-site, validation, upload, streaming and client-generation
problems found in the 2026-11-14 review (items 2, 3, 4.1, 5.1–5.4, 8.1–8.4,
10.1, 10.2), and give the package a test gate.

**Steps:**
- [x] `npm run check` = `tsc --noEmit` + `node --import tsx --test`; AGENTS.md names it
- [x] Acceptance tests from the criteria below, written before the code
- [x] Calls carry `X-Gold-Method`; requests without it get 403; multipart only for upload methods
- [x] `authorize(req, method)` option; false gives 403
- [x] Parameter validators derived from TS types; mismatch gives 400
- [x] `ApiError(status, message)`; any other error gives a generic 500, logged server-side
- [x] Upload temp files deleted after the call and on failed parses; default limit 100 MB
- [x] SSE: client parses `event:` frames, reports errors via `onError`, reconnects with backoff
- [x] SSE: `requestSignal()` aborts on disconnect; `nextEvent()` wraps it; server stops waiting on a closed stream
- [x] SSE / request bodies that are not JSON give a JSON 4xx, not an HTML page
- [x] Namespaces collected first; duplicate or invalid namespaces fail startup
- [x] Types imported into API files are emitted in `client.d.ts`; conflicting names fail startup
- [x] An API file that fails to import fails startup
- [x] JSON parsing scoped to `/gold_*`, limit `maxJsonBytes` (default 1 MB)

**Done when:**
1. A cross-site form post (no `X-Gold-Method`) to `/gold_request` gets 403 and the handler
   does not run.
2. A non-upload method called with multipart gets 415.
3. `authorize` returning false gives 403 for calls and streams.
4. Arguments not matching the declared TS type give 400 naming the parameter; types the
   validator cannot check fail startup naming the method.
5. `ApiError` status and message reach the client; other errors give
   `{"error":"Internal server error"}` with status 500.
6. Upload temp files no longer exist after the call returns or throws; over 100 MB gives 413.
7. The generated client delivers a stream `event: error` to `onError`, not the data callback.
8. The generated client reconnects when the connection drops, not after a clean end, and
   stops on 4xx.
9. A generator awaiting `nextEvent(target, name)`, or `once(target, name, { signal:
   requestSignal() })`, finishes when the client disconnects.
10. `/gold_sse` without a JSON body returns a JSON 4xx.
11. Two API files mapping to one namespace fail startup naming both files.
12. An interface imported into an API file appears in `client.d.ts`; two different
    declarations sharing a name fail startup.
13. An API file that throws on import fails startup.
14. A 200 KB JSON argument succeeds; one above `maxJsonBytes` gives a JSON 413.

**Decisions:**
- Test runner: `node:test` via `tsx` (approved 2026-11-14); no new dependency.
- New public API (approved 2026-11-14): `authorize` option, `ApiError`, `requestSignal()`,
  `maxJsonBytes` option. Validation derived from TS types. Upload default 100 MB.
- The method key moves from the body (`__method`) to the `X-Gold-Method` header. It is the
  cross-site guard (custom headers force a CORS preflight) and lets the server reject
  before reading an upload. Client and server are generated together, so no compatibility
  shim.
- Objects with properties not in the declared type are rejected (400), not stripped.
- `gild()` resolves to the `http.Server` so tests can listen on port 0.
- Stream `onError` receives an `Error` carrying the server message instead of a bare `Event`.
- Multipart non-file fields are always JSON-encoded by the client.
- `nextEvent(target, type)` added (approved 2026-11-14) so stream code does not pass the
  signal by hand. It cannot be fully hidden: a pending `await` in user code cannot be
  cancelled from outside, so the wait itself has to use the signal.

**Validation:** `npm run check` — `tsc --noEmit` clean; 55 tests, 55 pass, about 8 s
(18–33 s while the machine had a load average near 12). Run three times in a row without
flakes before the hardening additions, twice after. Every criterion above has a test in
`test/` (requests, uploads, streams, startup); `test/validation.test.ts` unit-tests the
validator. The tests were written first; the first run hung against the old code because
`gild()` did not return its server. Also checked through the example app (its own
acceptance suite, 6/6) with this checkout linked into its `node_modules`, and a manual
`gild({dev:true})` smoke: page served with the HMR script, a call answered.

**Hardening findings:**
- Fixed: an upload with a 400-character filename hung the request. The client's filename
  was part of the temp path, and write-stream errors had no listener. Temp files now get a
  server-chosen name (UUID plus a short plain extension); write errors fail the call.
- Fixed: a client that disconnected before a stream started (for example while an async
  `authorize` ran) left the generator running, because `close` had already fired.
- Fixed: unresolved parameter types (typo, missing lib) were TypeScript's error type,
  which behaves as `any`, so validation silently passed everything; now a startup error.
- Fixed: default client and frontend paths were computed from the working directory when
  the module loaded, not when `gild()` ran.
- Fixed: `app.listen` errors such as a port in use were ignored and "Server running" was
  still logged; `gild()` now rejects.
- Fixed: a non-4xx body-parser error was thrown inside body-parser's callback; it now
  becomes a 500 like any other error.
- Security: `authorize` runs before the method lookup, so callers it rejects cannot probe
  which methods exist. Validation errors echo property names from the request inside
  JSON only. No new dependencies.

**Limitations:**
- Streams send no heartbeat; a proxy with an idle timeout may cut a quiet stream (the
  client reconnects).
- Validation rejects properties the type does not declare: stricter than TypeScript's
  structural typing. `Date`, `Map`, class instances and generics cannot be parameters.
- Test gaps: the generated client is tested in Node, not in a browser; dev mode (januse,
  HMR, restart on change) only by the manual smoke; Windows paths are untested.
- `src/index.ts` is now about 1,190 lines. Splitting it by concept (multipart, client
  generation, discovery) would help; not done here to keep the change to what was asked.
- The missing-asset fallback that returns `index.html` with 200 (review item 7) is unchanged.

### Phase: API-only gold-janus (no Vite) — Done

**Goal:** Rebrand from gold-ts; drop Vite; keep API scan + client generation +
optional static; add `clientBaseUrl` and `watchBackend`.

**Done when:**
- Package name `gold-janus`; no vite peer
- `gild` registers `/gold_*`, generates client with optional base URL
- Serves `frontendDir` only when it exists
- README documents Janus pairing

**Validation (at the time):** example `npm run dev` / `npm start`, client fetch URLs
relative `/gold_*`. The dual-process setup (API on `:3010`, januse on `:8000`) has since
been replaced by one-process `gild({dev:true})`.
