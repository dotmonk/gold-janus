import express, { type Express, type Request, type Response } from "express";
import * as fs from "fs";
import type { IncomingMessage, Server, ServerResponse } from "http";
import { createRequire } from "module";
import * as path from "path";
import type { Duplex } from "stream";
import { pathToFileURL } from "url";

const DEFAULT_JANUS_SYNC_FROM = "node_modules/janus-elements/src/janus";
const DEFAULT_JANUS_SYNC_TO = "frontend/lib/janus";

type JanuseDev = {
  middleware: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  close: () => void;
};

export function setupDevMode(backendDir: string): void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  fs.watch(backendDir, { recursive: true }, (_event, filename) => {
    if (typeof filename !== "string" || !filename.endsWith(".ts")) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      console.log(`🔄 Gild: ${filename} changed — restarting…`);
      process.exit(0);
    }, 100);
  });
  console.log(`🔍 Gild: Watching ${backendDir} for changes`);
}

async function createJanuseDevFromCwd(): Promise<(options: {
  root?: string;
  watch?: string[];
  sync?: { from: string; to: string } | null;
}) => JanuseDev> {
  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  let entry: string;
  try {
    entry = requireFromCwd.resolve("janus-elements/januse");
  } catch {
    throw new Error(
      'gild({dev:true}) requires janus-elements in this project (import "janus-elements/januse")'
    );
  }
  const mod = (await import(pathToFileURL(entry).href)) as {
    createJanuseDev: (options: {
      root?: string;
      watch?: string[];
      sync?: { from: string; to: string } | null;
    }) => JanuseDev;
  };
  if (typeof mod.createJanuseDev !== "function") {
    throw new Error('janus-elements/januse did not export createJanuseDev');
  }
  return mod.createJanuseDev;
}

/** One-shot copy of janus into the app tree for production static serving. */
function syncJanusLibrary(): void {
  const fromDir = path.resolve(process.cwd(), DEFAULT_JANUS_SYNC_FROM);
  const toDir = path.resolve(process.cwd(), DEFAULT_JANUS_SYNC_TO);
  if (!fs.existsSync(fromDir)) {
    console.warn(`⚠️ Gild: janus sync skipped — missing ${fromDir}`);
    return;
  }
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  fs.rmSync(toDir, { recursive: true, force: true });
  fs.cpSync(fromDir, toDir, { recursive: true });
  console.log(`📦 Gild: Synced ${DEFAULT_JANUS_SYNC_FROM} → ${DEFAULT_JANUS_SYNC_TO}`);
}

/** Serves `frontend/` through januse (HMR + janus sync); call the result with the server for HMR sockets. */
export async function mountDevFrontend(app: Express): Promise<(server: Server) => void> {
  const createJanuseDev = await createJanuseDevFromCwd();
  const frontendRoot = path.resolve(process.cwd(), "frontend");
  if (!fs.existsSync(frontendRoot)) {
    throw new Error(`gild({dev:true}) expects a frontend/ directory at ${frontendRoot}`);
  }
  const januse = createJanuseDev({
    root: frontendRoot,
    watch: ["frontend"],
    sync: {
      from: DEFAULT_JANUS_SYNC_FROM,
      to: DEFAULT_JANUS_SYNC_TO,
    },
  });
  app.use((req, res, next) => {
    januse.middleware(req, res, next);
  });
  return (server) => {
    server.on("upgrade", (req, socket, head) => {
      januse.handleUpgrade(req, socket, head);
    });
  };
}

/** Copies janus into the app once, then serves `frontendDir` with an `index.html` fallback. */
export function mountStaticFrontend(app: Express, frontendDir: string): void {
  syncJanusLibrary();
  if (!fs.existsSync(frontendDir)) return;
  app.use(express.static(frontendDir));
  app.get("/*path", (_req: Request, res: Response) => {
    res.sendFile(path.join(frontendDir, "index.html"));
  });
}
