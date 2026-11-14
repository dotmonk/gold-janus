import type { Request, RequestHandler, Response } from "express";
import type { ParamInfo, RouteInfo } from "./discovery";
import { ApiError } from "./errors";
import { parseMultipart, type MultipartLimits, type UploadedFile } from "./multipart";
import { validate } from "./validation";

export interface ParsedPayload {
  fields: Record<string, unknown>;
  files: Record<string, UploadedFile | UploadedFile[]>;
  fieldsAreJsonText: boolean;
}

function bodyParserError(error: unknown): unknown {
  const { status, type } = (error ?? {}) as { status?: number; type?: string };
  if (status === 413) return new ApiError(413, "Payload too large");
  if (type === "entity.parse.failed") return new ApiError(400, "Invalid JSON body");
  if (typeof status === "number" && status >= 400 && status < 500) return new ApiError(status, "Invalid request body");
  return error;
}

export async function readJsonPayload(req: Request, res: Response, jsonParser: RequestHandler): Promise<ParsedPayload> {
  if (!req.is("application/json")) throw new ApiError(415, "Expected an application/json body");
  await new Promise<void>((resolve, reject) => {
    void jsonParser(req, res, (error?: unknown) => (error ? reject(bodyParserError(error)) : resolve()));
  });
  const body: unknown = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(400, "Expected a JSON object body");
  }
  return { fields: body as Record<string, unknown>, files: {}, fieldsAreJsonText: false };
}

export async function readPayload(
  req: Request,
  res: Response,
  route: RouteInfo,
  jsonParser: RequestHandler,
  limits: MultipartLimits,
  tempFiles: string[]
): Promise<ParsedPayload> {
  if (!req.is("multipart/form-data")) return readJsonPayload(req, res, jsonParser);
  if (!route.paramInfos.some((p) => p.kind === "file")) {
    throw new ApiError(415, `${route.dispatchKey} takes no uploads; send application/json`);
  }
  return parseMultipart(req, limits, tempFiles);
}

function fileArgument(p: ParamInfo, payload: ParsedPayload): unknown {
  const entry = payload.files[p.name];
  if (entry === undefined) {
    if (p.isOptional) return undefined;
    throw new ApiError(400, `${p.name}: required`);
  }
  if (p.isFileList) return Array.isArray(entry) ? entry : [entry];
  if (Array.isArray(entry)) throw new ApiError(400, `${p.name}: expected one file`);
  return entry;
}

function bodyArgument(p: ParamInfo, payload: ParsedPayload): unknown {
  let value = payload.fields[p.name];
  if (payload.fieldsAreJsonText && value !== undefined) {
    if (typeof value !== "string") throw new ApiError(400, `${p.name}: sent more than once`);
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new ApiError(400, `${p.name}: invalid JSON`);
    }
  }
  if (value === undefined) {
    if (p.isOptional) return undefined;
    throw new ApiError(400, `${p.name}: required`);
  }
  const error = p.schema ? validate(p.schema, value, p.name) : null;
  if (error) throw new ApiError(400, error);
  return value;
}

export function buildArguments(route: RouteInfo, payload: ParsedPayload): unknown[] {
  return route.paramInfos.map((p) => (p.kind === "file" ? fileArgument(p, payload) : bodyArgument(p, payload)));
}
