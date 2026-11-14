import assert from "node:assert/strict";
import * as fs from "node:fs";
import { test } from "node:test";
import { startFixture } from "./helpers";

test("two API files mapping to one namespace fail startup, naming both files", async () => {
  await assert.rejects(startFixture("duplicate-namespace"), (error: Error) => {
    assert.match(error.message, /"Users"/);
    assert.match(error.message, /a[\\/]usersApi\.ts/);
    assert.match(error.message, /b[\\/]usersApi\.ts/);
    return true;
  });
});

test("two different declarations sharing a type name fail startup", async () => {
  await assert.rejects(startFixture("conflicting-types"), (error: Error) => {
    assert.match(error.message, /"Thing"/);
    assert.match(error.message, /aApi\.ts/);
    assert.match(error.message, /bApi\.ts/);
    return true;
  });
});

test("an API file that throws on import fails startup", async () => {
  await assert.rejects(startFixture("import-failure"), /brokenApi\.ts[\s\S]*broken at import/);
});

test("a parameter type the validator cannot check fails startup, naming the method", async () => {
  await assert.rejects(startFixture("unsupported-type"), (error: Error) => {
    assert.match(error.message, /Dates\.when/);
    assert.match(error.message, /moment/);
    return true;
  });
});

test("types imported into API files are emitted in client.d.ts", async () => {
  const app = await startFixture("basic");
  try {
    const dts = fs.readFileSync(app.clientPath.replace(/\.js$/, ".d.ts"), "utf8");
    assert.match(dts, /export interface Item \{/);
    assert.match(dts, /export type Status = "open" \| "closed";/);
    assert.doesNotMatch(dts, /interface UploadedFile/);
    assert.match(dts, /upload\(file: File \| Blob, label: string\)/);
  } finally {
    await app.close();
  }
});

test("return and stream types that do not survive JSON fail startup, naming each method", async () => {
  await assert.rejects(startFixture("unsupported-return"), (error: Error) => {
    assert.match(error.message, /Clock\.now/);
    assert.match(error.message, /Clock\.ticks/);
    assert.doesNotMatch(error.message, /Clock\.fine/);
    return true;
  });
});
