import type { Express, Request, RequestHandler, Response } from "express";
import { callContext } from "./callContext";
import type { DispatchEntry, RequestHandlerFn, StreamHandlerFn } from "./discovery";
import { errorResponse } from "./errors";
import { removeTempFiles, type MultipartLimits } from "./multipart";
import { buildArguments, readJsonPayload, readPayload } from "./payload";

const METHOD_HEADER = "X-Gold-Method";
const STREAM_CLOSED = Symbol("stream closed");

/** Runs before every call and stream; false answers 403. */
export type Authorize = (req: Request, method: string) => boolean | Promise<boolean>;

/** Answers and returns null when the call is not allowed or unknown. */
async function admitCall<H>(
  req: Request,
  res: Response,
  dispatch: Map<string, DispatchEntry<H>>,
  authorize: Authorize | undefined
): Promise<DispatchEntry<H> | null> {
  const methodKey = req.get(METHOD_HEADER);
  if (!methodKey) {
    res.status(403).json({ error: `Missing ${METHOD_HEADER} header` });
    return null;
  }
  if (authorize && !(await authorize(req, methodKey))) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const entry = dispatch.get(methodKey);
  if (!entry) {
    res.status(404).json({ error: `Unknown method: ${methodKey}` });
    return null;
  }
  return entry;
}

function abortOnDisconnect(res: Response): AbortController {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  if (res.destroyed) controller.abort();
  return controller;
}

export function registerRequestRoute(
  app: Express,
  dispatch: Map<string, DispatchEntry<RequestHandlerFn>>,
  jsonParser: RequestHandler,
  limits: MultipartLimits,
  authorize: Authorize | undefined
): void {
  app.post("/gold_request", async (req, res) => {
    const methodKey = req.get(METHOD_HEADER) ?? "";
    const tempFiles: string[] = [];
    let outcome: { status: number; body: unknown };
    try {
      const entry = await admitCall(req, res, dispatch, authorize);
      if (!entry) return;
      const payload = await readPayload(req, res, entry.route, jsonParser, limits, tempFiles);
      const args = buildArguments(entry.route, payload);
      const controller = abortOnDisconnect(res);
      const result = await callContext.run({ signal: controller.signal }, () => entry.handler(...args));
      outcome = { status: 200, body: result };
    } catch (error: unknown) {
      const { status, message } = errorResponse(error, methodKey);
      outcome = { status, body: { error: message } };
    } finally {
      await removeTempFiles(tempFiles);
    }
    if (!res.headersSent) res.status(outcome.status).json(outcome.body);
  });
  console.log(`  → POST /gold_request (${dispatch.size} methods: ${[...dispatch.keys()].join(", ")})`);
}

function writeEvent(res: Response, event: string | null, data: unknown): void {
  const prefix = event ? `event: ${event}\n` : "";
  res.write(`${prefix}data: ${JSON.stringify(data ?? null)}\n\n`);
}

async function pipeStream(
  res: Response,
  start: () => AsyncGenerator<unknown>,
  methodKey: string,
  heartbeatMs: number
): Promise<void> {
  const controller = abortOnDisconnect(res);
  if (controller.signal.aborted) return;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(": ping\n\n"), heartbeatMs);

  const closed = new Promise<typeof STREAM_CLOSED>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(STREAM_CLOSED), { once: true });
  });

  await callContext.run({ signal: controller.signal }, async () => {
    const iterator = start();
    try {
      while (true) {
        const next = iterator.next();
        next.catch(() => undefined);
        const step = await Promise.race([next, closed]);
        if (step === STREAM_CLOSED) {
          iterator.return(undefined).catch(() => undefined);
          return;
        }
        if (step.done) {
          writeEvent(res, "end", {});
          return;
        }
        writeEvent(res, null, step.value);
      }
    } catch (error: unknown) {
      if (controller.signal.aborted) return;
      const { status, message } = errorResponse(error, methodKey);
      writeEvent(res, "error", { error: message, status });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  });
}

export function registerSSERoute(
  app: Express,
  dispatch: Map<string, DispatchEntry<StreamHandlerFn>>,
  jsonParser: RequestHandler,
  authorize: Authorize | undefined,
  heartbeatMs: number
): void {
  app.post("/gold_sse", async (req, res) => {
    const methodKey = req.get(METHOD_HEADER) ?? "";
    try {
      const entry = await admitCall(req, res, dispatch, authorize);
      if (!entry) return;
      const args = buildArguments(entry.route, await readJsonPayload(req, res, jsonParser));
      await pipeStream(res, () => entry.handler(...args), methodKey, heartbeatMs);
    } catch (error: unknown) {
      if (res.headersSent) return;
      const { status, message } = errorResponse(error, methodKey);
      res.status(status).json({ error: message });
    }
  });
  console.log(`  → POST /gold_sse (${dispatch.size} methods: ${[...dispatch.keys()].join(", ")})`);
}
