import express, { type Express } from "express";
import type { Server } from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import { clientDtsPath, clientJsPath, generateClient, normalizeClientBaseUrl } from "./clientGeneration";
import { checkCorsOrigins, corsForOrigins } from "./cors";
import { discoverApi } from "./discovery";
import { mountDevFrontend, mountStaticFrontend, setupDevMode } from "./frontend";
import type { MultipartLimits } from "./multipart";
import { registerRequestRoute, registerSSERoute, type Authorize } from "./routes";

export { nextEvent, requestSignal } from "./callContext";
export { ApiError } from "./errors";
export type { UploadedFile } from "./multipart";

const DEFAULT_MAX_MULTIPART_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_MULTIPART_FIELD_BYTES = 1024 * 1024;
const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_MULTIPART_TMP_DIR = path.join(os.tmpdir(), "gold-uploads");
const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;

export interface GildOptions {
  /** Port to listen on. Default: 3000 */
  port?: number;
  /**
   * Dev mode: mount januse (HMR + janus sync) for `frontend/`, and watch
   * backend Api.ts files then exit(0) for `tsx watch`. Requires `janus-elements`.
   * Default: false
   */
  dev?: boolean;
  /**
   * Watch backend/*.ts and exit(0) on change (for `tsx watch`).
   * Implied by `dev`. Default: false
   */
  watchBackend?: boolean;
  /**
   * Prefix baked into generated client fetch URLs. Default: "" (same-origin).
   * For a frontend on another origin, set the API origin here and list the
   * frontend's origin in `corsOrigins` on the API server.
   */
  clientBaseUrl?: string;
  /**
   * Exact origins (e.g. "https://app.example.com") allowed to call `/gold_*` from a
   * browser, with credentials. Default: none (same-origin only)
   */
  corsOrigins?: string[];
  /**
   * Path of the generated JS client (a matching `.d.ts` is written beside it).
   * Default: frontend/client.js
   */
  generatedClientPath?: string;
  /** Directory to serve when not in `dev`. Default: frontend/ */
  frontendDir?: string;
  /**
   * Runs before every call and stream with the method key (e.g. "Users.deleteUser").
   * Return false to answer 403. Default: everything allowed.
   */
  authorize?: Authorize;
  /** Max JSON request body in bytes. Default: 1 MB */
  maxJsonBytes?: number;
  /** Max multipart/form-data request size in bytes. Default: 100 MB */
  maxMultipartBytes?: number;
  /** Max size of a single non-file form field in bytes. Default: 1 MB */
  maxMultipartFieldBytes?: number;
  /** Directory to write uploaded temp files to. Default: OS temp dir */
  multipartTmpDir?: string;
  /** Interval of the keep-alive comment on open streams, in ms. Default: 15000 */
  streamHeartbeatMs?: number;
}

function listen(app: Express, port: number, onReady: (server: Server) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      onReady(server);
      resolve(server);
    });
  });
}

/** Registers `/gold_*`, writes the client, and resolves to the listening server. */
export default async function gild(app: Express, options: GildOptions = {}): Promise<Server> {
  const { port = 3000, dev = false, watchBackend = false, authorize, corsOrigins = [] } = options;
  checkCorsOrigins(corsOrigins);
  const generatedClientPath = options.generatedClientPath ?? path.resolve(process.cwd(), "frontend/client.js");
  const frontendDir = options.frontendDir ?? path.resolve(process.cwd(), "frontend");
  const clientBaseUrl = normalizeClientBaseUrl(options.clientBaseUrl ?? "");
  const limits: MultipartLimits = {
    maxBytes: options.maxMultipartBytes ?? DEFAULT_MAX_MULTIPART_BYTES,
    maxFieldBytes: options.maxMultipartFieldBytes ?? DEFAULT_MAX_MULTIPART_FIELD_BYTES,
    tmpDir: options.multipartTmpDir ?? DEFAULT_MULTIPART_TMP_DIR,
  };
  const jsonParser = express.json({ limit: options.maxJsonBytes ?? DEFAULT_MAX_JSON_BYTES });

  const api = await discoverApi();
  if (corsOrigins.length > 0) app.use(["/gold_request", "/gold_sse"], corsForOrigins(corsOrigins));
  if (api.requestDispatch.size > 0) registerRequestRoute(app, api.requestDispatch, jsonParser, limits, authorize);
  if (api.sseDispatch.size > 0) {
    const heartbeatMs = options.streamHeartbeatMs ?? DEFAULT_STREAM_HEARTBEAT_MS;
    registerSSERoute(app, api.sseDispatch, jsonParser, authorize, heartbeatMs);
  }
  console.log(`✅ Gild: Registered ${api.routes.length} routes`);
  await generateClient(api.routes, api.typeDeclarations, generatedClientPath, clientBaseUrl);

  if (dev || watchBackend) setupDevMode(api.backendDir);

  const logReady = (server: Server) => {
    const { port: boundPort } = server.address() as AddressInfo;
    console.log(`🚀 Gild: Server running on http://localhost:${boundPort}`);
    const jsOut = clientJsPath(generatedClientPath);
    console.log(`📝 Gild: Generated ${jsOut} (+ ${clientDtsPath(jsOut)})`);
  };

  if (dev) {
    const attachHmr = await mountDevFrontend(app);
    const server = await listen(app, port, logReady);
    attachHmr(server);
    return server;
  }

  mountStaticFrontend(app, frontendDir);
  return listen(app, port, logReady);
}
