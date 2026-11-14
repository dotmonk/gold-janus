import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { call, callJson, errorMessage, loadClient, startFixture, type RunningFixture } from "./helpers";

const validItem = { id: 1, label: "first" };

describe("requests", () => {
  let app: RunningFixture;
  before(async () => {
    app = await startFixture("basic");
  });
  after(() => app.close());

  test("a cross-site form post without X-Gold-Method is rejected before the handler runs", async () => {
    const before = await callJson(app.url, "Items.addItemCallCount", {});
    const form = new FormData();
    form.append("__method", "Items.addItem");
    form.append("item", JSON.stringify(validItem));
    const response = await fetch(`${app.url}/gold_request`, { method: "POST", body: form });
    assert.equal(response.status, 403);
    assert.match((await errorMessage(response)), /X-Gold-Method/);
    assert.equal(await callJson(app.url, "Items.addItemCallCount", {}), before);
  });

  test("multipart is refused for methods without upload parameters", async () => {
    const form = new FormData();
    form.append("item", JSON.stringify(validItem));
    const response = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "X-Gold-Method": "Items.addItem" },
      body: form,
    });
    assert.equal(response.status, 415);
  });

  test("an unknown method gives a JSON 404", async () => {
    const response = await call(app.url, "Items.nope", {});
    assert.equal(response.status, 404);
    assert.match((await errorMessage(response)), /Items\.nope/);
  });

  test("valid arguments reach the handler", async () => {
    assert.deepEqual(await callJson(app.url, "Items.addItem", { item: { ...validItem, tags: ["a"] } }), {
      ...validItem,
      tags: ["a"],
    });
    assert.equal(await callJson(app.url, "Items.setStatus", { id: 2, status: "open" }), "2:open:");
    assert.equal(await callJson(app.url, "Items.setStatus", { id: 2, status: "closed", note: "x" }), "2:closed:x");
    assert.equal(await callJson(app.url, "Items.setNullable", { value: null }), null);
    assert.equal(await callJson(app.url, "Items.countLabels", { labels: { a: 1, b: 2 } }), 2);
  });

  for (const [name, method, args, pathInError] of [
    ["wrong property type", "Items.addItem", { item: { id: "x", label: "l" } }, "item.id"],
    ["missing property", "Items.addItem", { item: { id: 1 } }, "item.label"],
    ["unexpected property", "Items.addItem", { item: { ...validItem, admin: true } }, "item.admin"],
    ["wrong array element", "Items.addItem", { item: { ...validItem, tags: [1] } }, "item.tags[0]"],
    ["missing required argument", "Items.addItem", {}, "item"],
    ["literal outside the union", "Items.setStatus", { id: 1, status: "bogus" }, "status"],
    ["null where not allowed", "Items.setStatus", { id: 1, status: "open", note: null }, "note"],
    ["record value of wrong type", "Items.countLabels", { labels: { a: "x" } }, "labels.a"],
  ] as const) {
    test(`arguments not matching the TS type give 400: ${name}`, async () => {
      const response = await call(app.url, method, args);
      assert.equal(response.status, 400);
      const error = await errorMessage(response);
      assert.ok(error.includes(pathInError), `expected "${pathInError}" in "${error}"`);
    });
  }

  test("ApiError status and message reach the caller", async () => {
    const response = await call(app.url, "Items.fail", { kind: "api" });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Already exists" });
  });

  test("other errors become a generic 500 without internal details", async () => {
    const response = await call(app.url, "Items.fail", { kind: "crash" });
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { error: "Internal server error" });
    assert.ok(!body.includes("secret"));
  });

  test("the generated client rejects with the server message and status", async () => {
    const client = await loadClient(app.clientPath);
    await assert.rejects(client.Items.fail("api") as Promise<unknown>, (error: Error & { status?: number }) => {
      assert.equal(error.message, "Already exists");
      assert.equal(error.status, 409);
      return true;
    });
    assert.deepEqual(await client.Items.addItem(validItem), validItem);
    assert.equal(await client.Items.setStatus(3, "open"), "3:open:");
  });

  test("a body that is not JSON gives a JSON 4xx", async () => {
    const malformed = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Gold-Method": "Items.addItem" },
      body: "{not json",
    });
    assert.equal(malformed.status, 400);
    assert.ok(await errorMessage(malformed));

    const plain = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", "X-Gold-Method": "Items.addItem" },
      body: "hello",
    });
    assert.equal(plain.status, 415);
    assert.ok(await errorMessage(plain));
  });

  test("a 200 KB JSON argument is accepted and the 1 MB default is enforced", async () => {
    assert.equal(await callJson(app.url, "Items.textLength", { text: "a".repeat(200_000) }), 200_000);
    const tooLarge = await call(app.url, "Items.textLength", { text: "a".repeat(2_000_000) });
    assert.equal(tooLarge.status, 413);
    assert.ok(await errorMessage(tooLarge));
  });
});

describe("request options", () => {
  test("maxJsonBytes limits JSON bodies", async () => {
    const app = await startFixture("basic", { maxJsonBytes: 1000 });
    try {
      const response = await call(app.url, "Items.textLength", { text: "a".repeat(2000) });
      assert.equal(response.status, 413);
      assert.ok(await errorMessage(response));
    } finally {
      await app.close();
    }
  });

  test("authorize returning false gives 403 and receives the method key", async () => {
    const seen: string[] = [];
    const app = await startFixture("basic", {
      authorize: (_req, method) => {
        seen.push(method);
        return method !== "Items.fail";
      },
    });
    try {
      const denied = await call(app.url, "Items.fail", { kind: "api" });
      assert.equal(denied.status, 403);
      assert.equal((await call(app.url, "Items.textLength", { text: "ok" })).status, 200);
      assert.deepEqual(seen, ["Items.fail", "Items.textLength"]);
    } finally {
      await app.close();
    }
  });
});
