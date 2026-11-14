import type { Request } from "express";
import { randomUUID } from "crypto";
import { once } from "events";
import * as fs from "fs";
import * as path from "path";
import { ApiError } from "./errors";
import type { ParsedPayload } from "./payload";

const CRLF = "\r\n";

export interface UploadedFile {
  fieldName: string;
  filename: string;
  contentType: string;
  size: number;
  /** Deleted when the API call returns or throws; copy the file during the call to keep it. */
  tempFilePath: string;
  createReadStream: () => fs.ReadStream;
  readAsBuffer: () => Promise<Buffer>;
}

export interface MultipartLimits {
  maxBytes: number;
  maxFieldBytes: number;
  tmpDir: string;
}

export async function removeTempFiles(tempFiles: string[]): Promise<void> {
  await Promise.all(tempFiles.map((tempFile) => fs.promises.rm(tempFile, { force: true })));
}

function addEntry<T>(target: Record<string, T | T[]>, key: string, value: T): void {
  const existing = target[key];
  if (existing === undefined) { target[key] = value; return; }
  if (Array.isArray(existing)) { existing.push(value); return; }
  target[key] = [existing, value];
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const name = value.match(/name="([^"]*)"/i)?.[1] ?? value.match(/name=([^;]+)/i)?.[1]?.trim();
  const filename = value.match(/filename="([^"]*)"/i)?.[1] ?? value.match(/filename=([^;]+)/i)?.[1]?.trim();
  return { name, filename };
}

/** The client's filename never reaches the file system; only a short plain extension does. */
function tempFileExtension(filename: string): string {
  const extension = path.extname(filename);
  return /^\.[A-Za-z0-9]{1,16}$/.test(extension) ? extension : "";
}

async function writeChunk(stream: fs.WriteStream, chunk: Buffer): Promise<void> {
  if (!stream.write(chunk)) await once(stream, "drain");
}

/** Every temp file created is pushed to `tempFiles`; the caller removes them. */
export async function parseMultipart(req: Request, limits: MultipartLimits, tempFiles: string[]): Promise<ParsedPayload> {
  const ct = req.headers["content-type"] ?? "";
  const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = bm?.[1] ?? bm?.[2];
  if (!boundary) throw new ApiError(400, "Multipart boundary missing");

  fs.mkdirSync(limits.tmpDir, { recursive: true });

  const boundaryLine = Buffer.from(`--${boundary}`);
  const boundaryWithCrlf = Buffer.from(`\r\n--${boundary}`);
  const headerDelimiter = Buffer.from("\r\n\r\n");
  const bodyTailSize = boundaryWithCrlf.length + 8;

  const fields: Record<string, unknown> = {};
  const files: Record<string, UploadedFile | UploadedFile[]> = {};

  let totalBytes = 0;
  let buffer = Buffer.alloc(0);
  let state: "preamble" | "headers" | "body" | "done" = "preamble";

  let partFieldName = "";
  let partFileName: string | undefined;
  let partContentType: string | undefined;
  let partFilePath: string | undefined;
  let partFileStream: fs.WriteStream | null = null;
  let partFileSize = 0;
  let partFieldChunks: Buffer[] = [];
  let partFieldSize = 0;
  let fileWriteError: unknown = null;

  const resetPart = () => {
    partFieldName = "";
    partFileName = undefined;
    partContentType = undefined;
    partFilePath = undefined;
    partFileStream = null;
    partFileSize = 0;
    partFieldChunks = [];
    partFieldSize = 0;
  };

  const consumeBody = async (chunk: Buffer) => {
    if (chunk.length === 0) return;
    if (fileWriteError) throw fileWriteError;
    if (partFileStream) {
      await writeChunk(partFileStream, chunk);
      partFileSize += chunk.length;
      return;
    }
    partFieldSize += chunk.length;
    if (partFieldSize > limits.maxFieldBytes) throw new ApiError(413, "Multipart field too large");
    partFieldChunks.push(Buffer.from(chunk));
  };

  const finalizePart = async () => {
    if (!partFieldName) return;
    if (partFileStream && partFilePath && partFileName) {
      const finalizedPath = partFilePath;
      partFileStream.end();
      await once(partFileStream, "close");
      if (fileWriteError) throw fileWriteError;
      addEntry(files, partFieldName, {
        fieldName: partFieldName,
        filename: partFileName,
        contentType: partContentType ?? "application/octet-stream",
        size: partFileSize,
        tempFilePath: finalizedPath,
        createReadStream: () => fs.createReadStream(finalizedPath),
        readAsBuffer: () => fs.promises.readFile(finalizedPath),
      });
    } else {
      addEntry(fields, partFieldName, Buffer.concat(partFieldChunks).toString("utf8"));
    }
    resetPart();
  };

  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > limits.maxBytes) throw new ApiError(413, "Payload too large");
      buffer = Buffer.concat([buffer, buf]);

      while (buffer.length > 0) {
        if (state === "done") { buffer = Buffer.alloc(0); break; }

        if (state === "preamble") {
          const idx = buffer.indexOf(boundaryLine);
          if (idx === -1) {
            const keep = Math.min(buffer.length, boundaryLine.length);
            buffer = buffer.subarray(buffer.length - keep);
            break;
          }
          buffer = buffer.subarray(idx + boundaryLine.length);
          if (buffer.length < 2) break;
          if (buffer[0] === 45 && buffer[1] === 45) { state = "done"; break; }
          if (buffer[0] !== 13 || buffer[1] !== 10) throw new ApiError(400, "Invalid multipart boundary framing");
          buffer = buffer.subarray(2);
          state = "headers";
          continue;
        }

        if (state === "headers") {
          const headerEnd = buffer.indexOf(headerDelimiter);
          if (headerEnd === -1) break;
          const rawHeaders = buffer.subarray(0, headerEnd).toString("utf8");
          buffer = buffer.subarray(headerEnd + headerDelimiter.length);

          const headerLines = rawHeaders.split(CRLF);
          const disposition = headerLines.find((l) => l.toLowerCase().startsWith("content-disposition:"));
          if (!disposition) throw new ApiError(400, "Multipart part missing Content-Disposition");
          const { name, filename } = parseContentDisposition(disposition);
          if (!name) throw new ApiError(400, "Multipart part missing field name");

          partFieldName = name;
          partFileName = filename;
          partContentType = headerLines
            .find((l) => l.toLowerCase().startsWith("content-type:"))
            ?.split(":")[1]?.trim();

          if (partFileName) {
            partFilePath = path.join(limits.tmpDir, `${randomUUID()}${tempFileExtension(partFileName)}`);
            tempFiles.push(partFilePath);
            partFileStream = fs.createWriteStream(partFilePath);
            partFileStream.on("error", (error) => {
              fileWriteError ??= error;
            });
          }
          state = "body";
          continue;
        }

        // state === "body"
        const boundaryIdx = buffer.indexOf(boundaryWithCrlf);
        if (boundaryIdx === -1) {
          if (buffer.length <= bodyTailSize) break;
          const emit = buffer.subarray(0, buffer.length - bodyTailSize);
          buffer = buffer.subarray(buffer.length - bodyTailSize);
          await consumeBody(emit);
          continue;
        }

        await consumeBody(buffer.subarray(0, boundaryIdx));
        buffer = buffer.subarray(boundaryIdx + 2);
        await finalizePart();

        if (buffer.length < boundaryLine.length + 2) break;
        if (!buffer.subarray(0, boundaryLine.length).equals(boundaryLine)) throw new ApiError(400, "Invalid multipart boundary");

        const markerIdx = boundaryLine.length;
        const b0 = buffer[markerIdx];
        const b1 = buffer[markerIdx + 1];
        if (b0 === 45 && b1 === 45) { buffer = buffer.subarray(markerIdx + 2); state = "done"; continue; }
        if (b0 !== 13 || b1 !== 10) throw new ApiError(400, "Invalid multipart separator");
        buffer = buffer.subarray(markerIdx + 2);
        state = "headers";
      }
    }
  } catch (error) {
    const openStream = partFileStream as fs.WriteStream | null;
    if (openStream) {
      openStream.destroy();
      await once(openStream, "close").catch(() => undefined);
    }
    throw error;
  }

  if (state !== "done") throw new ApiError(400, "Incomplete multipart payload");
  return { fields, files, fieldsAreJsonText: true };
}
