import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { callJson, errorMessage, loadClient, readSseFrames, startFixture, waitFor, type RunningFixture } from "./helpers";

function openStream(url: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return fetch(`${url}/gold_sse`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Gold-Method": method },
    body: JSON.stringify(body),
    signal,
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("streams over HTTP", () => {
  let app: RunningFixture;
  before(async () => {
    app = await startFixture("basic");
  });
  after(() => app.close());

  test("a finished generator ends with an end event", async () => {
    const frames = await readSseFrames(await openStream(app.url, "Streams.countFrom", { start: 5 }), 3);
    assert.deepEqual(frames, [
      { event: "message", data: 5 },
      { event: "message", data: 6 },
      { event: "end", data: {} },
    ]);
  });

  test("an ApiError thrown mid-stream becomes an error event with its status", async () => {
    const frames = await readSseFrames(await openStream(app.url, "Streams.failAfterFirst", {}), 2);
    assert.deepEqual(frames, [
      { event: "message", data: "first" },
      { event: "error", data: { error: "stream conflict", status: 409 } },
    ]);
  });

  test("other errors mid-stream do not leak details", async () => {
    const frames = await readSseFrames(await openStream(app.url, "Streams.crashAfterFirst", {}), 2);
    assert.deepEqual(frames[1], { event: "error", data: { error: "Internal server error", status: 500 } });
  });

  test("stream arguments are validated before the stream starts", async () => {
    const response = await openStream(app.url, "Streams.countFrom", { start: "five" });
    assert.equal(response.status, 400);
    assert.match((await errorMessage(response)), /start/);
  });

  test("a stream request without a JSON body gives a JSON 4xx", async () => {
    const response = await fetch(`${app.url}/gold_sse`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Gold-Method": "Streams.countFrom" },
      body: "x",
    });
    assert.equal(response.status, 415);
    assert.ok(await errorMessage(response));
  });

  test("a stream request without X-Gold-Method gives 403", async () => {
    const response = await fetch(`${app.url}/gold_sse`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 403);
  });

  test("requestSignal() aborts when the client disconnects, so the generator finishes", async () => {
    const before = (await callJson(app.url, "Streams.finishedWaitCount", {})) as number;
    const controller = new AbortController();
    const response = await openStream(app.url, "Streams.waitUntilDisconnect", {}, controller.signal);
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await waitFor(async () => ((await callJson(app.url, "Streams.finishedWaitCount", {})) as number) > before);
  });

  test("nextEvent() delivers events and stops waiting when the client disconnects", async () => {
    const before = (await callJson(app.url, "Streams.finishedPingWaitCount", {})) as number;
    const controller = new AbortController();
    const response = await openStream(app.url, "Streams.streamPings", {}, controller.signal);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    const readUntil = async (text: string) => {
      while (!received.includes(text)) received += decoder.decode((await reader.read()).value, { stream: true });
    };
    await readUntil('data: "ready"');
    await callJson(app.url, "Streams.ping", { message: "hello" });
    await readUntil('data: "hello"');
    controller.abort();
    await waitFor(async () => ((await callJson(app.url, "Streams.finishedPingWaitCount", {})) as number) > before);
  });
});

describe("streams through the generated client", () => {
  test("an error event goes to onError, not to the data callback", async () => {
    const app = await startFixture("basic");
    const received: unknown[] = [];
    const errors: (Error & { status?: number })[] = [];
    const client = await loadClient(app.clientPath);
    const stop = client.Streams.failAfterFirst(
      (data: unknown) => received.push(data),
      (error: Error) => errors.push(error)
    ) as () => void;
    try {
      await waitFor(() => errors.length > 0);
      assert.deepEqual(received, ["first"]);
      assert.equal(errors[0].message, "stream conflict");
      assert.equal(errors[0].status, 409);
    } finally {
      stop();
      await app.close();
    }
  });

  test("a completed stream is not reopened", async () => {
    const app = await startFixture("basic");
    const received: unknown[] = [];
    const client = await loadClient(app.clientPath);
    const stop = client.Streams.countFrom(1, (data: unknown) => received.push(data)) as () => void;
    try {
      await waitFor(() => received.length === 2);
      await sleep(1500);
      assert.deepEqual(received, [1, 2]);
    } finally {
      stop();
      await app.close();
    }
  });

  test("the client reconnects after the server goes away and comes back", async () => {
    const first = await startFixture("basic");
    const received: unknown[] = [];
    const errors: Error[] = [];
    const client = await loadClient(first.clientPath);
    const stop = client.Streams.waitUntilDisconnect(
      (data: unknown) => received.push(data),
      (error: Error) => errors.push(error)
    ) as () => void;
    let second: Awaited<ReturnType<typeof startFixture>> | undefined;
    try {
      await waitFor(() => received.length === 1);
      await first.close();
      second = await startFixture("basic", { port: first.port });
      await waitFor(() => received.length === 2, 8000);
      assert.deepEqual(received, ["ready", "ready"]);
    } finally {
      stop();
      await second?.close();
    }
  });

  test("a 4xx response stops the client from reconnecting", async () => {
    let attempts = 0;
    const app = await startFixture("basic", {
      authorize: (_req, method) => {
        if (method === "Streams.countFrom") attempts++;
        return method !== "Streams.countFrom";
      },
    });
    const errors: (Error & { status?: number })[] = [];
    const client = await loadClient(app.clientPath);
    const stop = client.Streams.countFrom(1, () => {}, (error: Error) => errors.push(error)) as () => void;
    try {
      await waitFor(() => errors.length === 1);
      await sleep(1500);
      assert.equal(attempts, 1);
      assert.equal(errors.length, 1);
      assert.equal(errors[0].status, 403);
    } finally {
      stop();
      await app.close();
    }
  });
});

describe("streams and slow authorization", () => {
  test("a client that leaves while authorize is pending does not leave a stream running", async () => {
    const app = await startFixture("basic", {
      authorize: async (_req, method) => {
        if (method === "Streams.waitUntilDisconnect") await sleep(300);
        return true;
      },
    });
    try {
      const controller = new AbortController();
      const pending = openStream(app.url, "Streams.waitUntilDisconnect", {}, controller.signal).catch(() => undefined);
      await sleep(50);
      controller.abort();
      await pending;
      await sleep(600);
      assert.equal(await callJson(app.url, "Streams.runningWaitCount", {}), 0);
    } finally {
      await app.close();
    }
  });
});
