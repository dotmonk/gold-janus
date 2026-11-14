import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, test } from "node:test";
import { callJson, errorMessage, loadClient, startFixture, type RunningFixture } from "./helpers";

function uploadForm(field: string, content: string, extra: Record<string, unknown> = {}): FormData {
  const form = new FormData();
  form.append(field, new Blob([content], { type: "text/plain" }), "note.txt");
  for (const [name, value] of Object.entries(extra)) form.append(name, JSON.stringify(value));
  return form;
}

describe("uploads", () => {
  let app: RunningFixture;
  let tmpDir: string;
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gold-janus-test-uploads-"));
    app = await startFixture("basic", { multipartTmpDir: tmpDir, maxMultipartBytes: 10_000 });
  });
  after(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("the handler reads the upload and its temp file is gone afterwards", async () => {
    const response = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "X-Gold-Method": "Uploads.upload" },
      body: uploadForm("file", "hello upload", { label: "greeting" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { label: "greeting", text: "hello upload" });
    const seen = (await callJson(app.url, "Uploads.seenUploads", {})) as string[];
    assert.ok(seen.length > 0);
    for (const tempPath of seen) assert.equal(fs.existsSync(tempPath), false, tempPath);
  });

  test("temp files are removed when the handler throws", async () => {
    const response = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "X-Gold-Method": "Uploads.uploadThenFail" },
      body: uploadForm("file", "doomed"),
    });
    assert.equal(response.status, 500);
    const seen = (await callJson(app.url, "Uploads.seenUploads", {})) as string[];
    for (const tempPath of seen) assert.equal(fs.existsSync(tempPath), false, tempPath);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  test("an upload over maxMultipartBytes gives 413 and leaves no temp file", async () => {
    const response = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "X-Gold-Method": "Uploads.upload" },
      body: uploadForm("file", "x".repeat(50_000), { label: "big" }),
    });
    assert.equal(response.status, 413);
    assert.ok(await errorMessage(response));
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  test("a non-file field that does not match its type gives 400", async () => {
    const response = await fetch(`${app.url}/gold_request`, {
      method: "POST",
      headers: { "X-Gold-Method": "Uploads.upload" },
      body: uploadForm("file", "hi", { label: 42 }),
    });
    assert.equal(response.status, 400);
    assert.match((await errorMessage(response)), /label/);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  test("the generated client uploads a Blob with a typed field", async () => {
    const client = await loadClient(app.clientPath);
    const result = await client.Uploads.upload(new Blob(["from client"]), "client");
    assert.deepEqual(result, { label: "client", text: "from client" });
  });
});

describe("hostile uploads", () => {
  test("a very long filename neither crashes the server nor leaves a temp file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gold-janus-test-uploads-"));
    const app = await startFixture("basic", { multipartTmpDir: tmpDir });
    try {
      const form = new FormData();
      form.append("file", new Blob(["x"]), `${"a".repeat(400)}.txt`);
      form.append("label", JSON.stringify("long"));
      const response = await fetch(`${app.url}/gold_request`, {
        method: "POST",
        headers: { "X-Gold-Method": "Uploads.upload" },
        body: form,
      });
      assert.equal(response.status, 200);
      assert.equal(((await response.json()) as { text: string }).text, "x");
      assert.equal((await callJson(app.url, "Items.textLength", { text: "still up" })), 8);
      assert.deepEqual(fs.readdirSync(tmpDir), []);
    } finally {
      await app.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
