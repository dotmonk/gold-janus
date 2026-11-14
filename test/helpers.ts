import express from "express";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import gild, { type GildOptions } from "gold-janus";

export interface RunningFixture {
  url: string;
  port: number;
  dir: string;
  clientPath: string;
  server: Server;
  close: () => Promise<void>;
}

export function fixtureDir(name: string): string {
  return path.join(__dirname, "fixtures", name);
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
    probe.on("error", reject);
  });
}

export async function startFixture(name: string, options: GildOptions = {}): Promise<RunningFixture> {
  const dir = fixtureDir(name);
  process.chdir(dir);
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "gold-janus-test-client-"));
  const clientPath = path.join(clientDir, "client.js");
  let server: Server;
  try {
    server = await gild(express(), { clientBaseUrl: url, generatedClientPath: clientPath, ...options, port });
  } catch (error) {
    fs.rmSync(clientDir, { recursive: true, force: true });
    throw error;
  }
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        fs.rmSync(clientDir, { recursive: true, force: true });
        resolve();
      });
    });
  return { url, port, dir, clientPath, server, close };
}

export function call(
  url: string,
  method: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {}
): Promise<Response> {
  return fetch(`${url}/gold_request`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gold-Method": method, ...headers },
    body: JSON.stringify(args),
  });
}

export async function callJson(url: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await call(url, method, args);
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} failed with ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

export interface SseFrame {
  event: string;
  data: unknown;
}

export async function readSseFrames(response: Response, count: number): Promise<SseFrame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = "";
  while (frames.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) !== -1 && frames.length < count) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      let data = "";
      for (const line of raw.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      frames.push({ event, data: data ? JSON.parse(data) : undefined });
    }
  }
  await reader.cancel();
  return frames;
}

type GeneratedClient = Record<string, Record<string, (...args: unknown[]) => unknown>>;

// Imported as a data: URL because the tsx loader caches file URLs even with a query string.
export async function loadClient(clientPath: string): Promise<GeneratedClient> {
  const source = fs.readFileSync(clientPath, "utf8");
  const url = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  return ((await import(url)) as { default: GeneratedClient }).default;
}

export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function errorMessage(response: Response): Promise<string> {
  return ((await response.json()) as { error: string }).error;
}
