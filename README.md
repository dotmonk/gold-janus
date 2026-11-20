# gold-janus

Minimal TypeScript API layer that auto-generates a type-safe client from your
backend `*Api.ts` files at startup. In `dev` mode it mounts
[`janus-elements`](https://github.com/dotmonk/janus-elements) januse (HMR +
janus sync) on the same origin — same one-process DX as gold-ts + Vite.

Zero decorators, zero codegen CLI. Define functions — get a client.

## Installation

```sh
npm install github:dotmonk/gold-janus
npm install github:dotmonk/janus-elements#09fb3f33aaf4b713635a4c2124282fb121c49157
```

> Requires [`tsx`](https://github.com/privatenumber/tsx) to run TypeScript
> directly (including from `node_modules`).

## Quick Start

### 1. Backend entry point — `backend/index.ts`

```ts
import express from "express";
import gild from "gold-janus";

const app = express();
void gild(app, {
  port: 3010,
  dev: true,
});
```

Run with:

```sh
npx tsx watch backend/index.ts
```

Open [http://localhost:3010/](http://localhost:3010/) — API and UI share the
origin. Backend `*Api.ts` changes exit(0) so `tsx watch` restarts; frontend
edits HMR via januse.

### 2. Define an API — `backend/api/usersApi.ts`

Any `*Api.ts` file under `backend/` is picked up automatically.

```ts
interface User { name: string; age: number; }

const users: User[] = [];

export async function createUser(user: User): Promise<User> {
  users.push(user);
  return user;
}

export async function* streamListUsers(): AsyncGenerator<User[]> {
  yield users;
}
```

### 3. Generated client — `frontend/client.js` (+ `client.d.ts`)

On startup, `gild` writes a browser-ready JS client and a sibling `.d.ts`.
Import the `.js` from Janus (or any) frontend:

```ts
import { Users } from "./client.js";

await Users.createUser({ name: "Alice", age: 30 });
const stop = Users.streamListUsers(
  (list) => console.log(list),
  (error) => console.warn(error.message, error.status),
);
```

Interfaces and type aliases declared in, or imported into, `*Api.ts` files are
copied into `client.d.ts`. Two different declarations with the same name fail
startup.

## Startup checks

`gild` refuses to start (its promise rejects) when:

- two `*Api.ts` files map to the same namespace, e.g. `a/usersApi.ts` and
  `b/usersApi.ts`, or a file name does not give a valid identifier;
- an `*Api.ts` file throws while being imported;
- a parameter type cannot be checked at runtime: functions, class instances such
  as `Date` or `Map`, generic type parameters, `bigint`, unresolved types;
- a return type (or a stream's value type) would arrive differently after JSON,
  for the same reasons: return `string` from `toISOString()` instead of a `Date`;
- two different type declarations share a name, or an API type references an
  enum or class.

## Requests, validation and errors

The client sends the method key in an `X-Gold-Method` header. Requests without it
get 403, so a plain cross-site form post cannot call your API: a custom header
forces a CORS preflight, which gold-janus answers only for `corsOrigins`.

Arguments are checked against the declared TypeScript parameter types before the
function runs. A mismatch, a missing required argument or a property the type
does not declare gives 400 naming the path, e.g. `user.age: expected number, got
string`.

Throw `ApiError` for errors the caller should see; any other error is logged on
the server and answered with a generic 500.

```ts
import { ApiError } from "gold-janus";

export async function deleteUser(index: number): Promise<User> {
  if (!users[index]) throw new ApiError(404, "No such user");
  return users.splice(index, 1)[0];
}
```

Client calls reject with an `Error` carrying the server message and `status`.

Use `authorize` to gate calls and streams, e.g. on a session cookie:

```ts
void gild(app, { authorize: (req, method) => isSignedIn(req) || method === "Auth.signIn" });
```

## Frontend on another origin

Serve the API with `corsOrigins` listing the frontend's exact origin, and point
the client at the API:

```ts
void gild(app, {
  corsOrigins: ["https://app.example.com"],
  clientBaseUrl: "https://api.example.com",
});
```

Listed origins get CORS headers with credentials, so cookies (and an `authorize`
based on them) work; the client always sends `credentials: "include"`. Cookies
still need `SameSite=None; Secure` to be sent cross-site. Unlisted origins get no
CORS headers, so browsers block them.

## Streams

Async generators become server-sent event streams.

- The stream ends cleanly when the generator returns; the client does not reopen it.
- If the connection drops (server restart, network), the client reconnects with
  backoff from 1 s up to 30 s and calls `onError`.
- An error thrown in the generator reaches `onError` with its message and status;
  4xx errors and 4xx responses stop reconnecting.
- Open streams get a `: ping` comment every 15 s (`streamHeartbeatMs`) so proxies
  do not close them as idle; the client ignores it.
- Wait for changes with `nextEvent(target, type)`. When the client disconnects
  the wait rejects, so the generator stops at once instead of waiting for the next
  event:

```ts
import { nextEvent } from "gold-janus";

const changes = new EventTarget();

export async function* streamListUsers(): AsyncGenerator<User[]> {
  yield users;
  while (true) {
    await nextEvent(changes, "users");
    yield users;
  }
}
```

JavaScript cannot cancel a pending `await` from outside, so a generator waiting
some other way keeps waiting until it next wakes up (the response itself still
closes immediately). For other waits, such as `fetch` or timers, pass
`requestSignal()`: the call's `AbortSignal`, which aborts on disconnect.

## Production

Leave `dev` false (or unset). Dev mode listens on 127.0.0.1 only; production on
all interfaces unless `host` says otherwise. On startup `gild` syncs janus into
`frontend/lib/janus` once and serves `frontendDir` (default `frontend/`).
No separate build step. Client fetch URLs stay same-origin. `tsx` runs the
backend at runtime, so list it under `dependencies`, not `devDependencies`.

## File uploads

Parameters typed as `UploadedFile` (or `UploadedFile[]`) become multipart fields.
Pass `File | Blob` from the browser. Temp files are deleted when the call returns
or throws; copy `tempFilePath` during the call to keep the file. Only methods with
an upload parameter accept multipart (others get 415). Streams cannot take uploads.

## API — `gild(app, options?)`

Returns a promise of the listening `http.Server`. `gild` parses JSON only on its
own `/gold_*` routes; add `express.json()` yourself for other routes.

| Option | Type | Default | Description |
|---|---|---|---|
| `port` | `number` | `3000` | Listen port |
| `host` | `string` | `127.0.0.1` in `dev`, else all interfaces | Listen address |
| `dev` | `boolean` | `false` | Mount januse on `frontend/` + watch backend for `tsx watch` |
| `watchBackend` | `boolean` | `false` | Watch `backend/**/*.ts` and exit(0); implied by `dev` |
| `clientBaseUrl` | `string` | `""` | Prefix for generated `fetch` URLs (same-origin by default) |
| `corsOrigins` | `string[]` | none | Exact origins allowed to call `/gold_*` from a browser, with credentials |
| `generatedClientPath` | `string` | `frontend/client.js` | JS client path (`.d.ts` written beside it) |
| `frontendDir` | `string` | `frontend/` | Served when not in `dev` (after a one-shot janus sync) |
| `authorize` | `(req, method) => boolean \| Promise<boolean>` | allow all | Runs before every call and stream; `false` gives 403 |
| `maxJsonBytes` | `number` | 1 MB | Max JSON request body |
| `maxMultipartBytes` | `number` | 100 MB | Max multipart body |
| `maxMultipartFieldBytes` | `number` | 1 MB | Max non-file field |
| `multipartTmpDir` | `string` | OS temp | Upload temp directory |
| `streamHeartbeatMs` | `number` | 15000 | Interval of the keep-alive comment on open streams |

Exports: `gild` (default), `ApiError`, `nextEvent`, `requestSignal`, and the types
`GildOptions` and `UploadedFile`.

## Development

```sh
npm install
npm run check   # tsc --noEmit + node:test suite (about 10 s)
npm test        # tests only
```

Tests live in `test/`; `test/fixtures/` holds small apps that `gild` is started
against on a free port. The cross-origin behaviour was checked once in Chromium,
Firefox and WebKit (Playwright image from janus-elements); that check is not part
of `npm run check`.

| Source | Concern |
|---|---|
| `src/index.ts` | `gild()`, options and defaults, public exports |
| `src/discovery.ts` | Finding `*Api.ts`, startup checks, types for `client.d.ts` |
| `src/validation.ts` | Runtime checks derived from TypeScript types |
| `src/routes.ts` | `/gold_request` and `/gold_sse`: admission, calls, streams |
| `src/payload.ts` | Reading JSON or multipart bodies into arguments |
| `src/multipart.ts` | Streaming multipart parser and temp files |
| `src/cors.ts` | CORS for `corsOrigins` |
| `src/callContext.ts` | `requestSignal()`, `nextEvent()` |
| `src/errors.ts` | `ApiError` and error responses |
| `src/clientGeneration.ts` | Writes `client.js` and `client.d.ts` |
| `src/clientRuntime.js` | Fetch and stream helpers copied into every generated client |
| `src/frontend.ts` | Dev (januse) and production static serving |

## Example

[`gold-janus-example`](https://github.com/dotmonk/gold-janus-example) — live
clock, users CRUD over SSE, chat with image upload, a gold Janus theme.
