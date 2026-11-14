import assert from "node:assert/strict";
import { test } from "node:test";
import { Project, ScriptTarget } from "ts-morph";
import { schemaFromType, UnsupportedTypeError, validate, type Schema } from "../src/validation";

function schemaFor(source: string, parameterType: string): Schema {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true, target: ScriptTarget.ES2022 } });
  const file = project.createSourceFile("api.ts", `${source}\nexport function target(value: ${parameterType}) {}`);
  const parameter = file.getFunctionOrThrow("target").getParameters()[0];
  return schemaFromType(parameter.getType(), parameter);
}

test("primitives and literals", () => {
  assert.equal(validate(schemaFor("", "string"), "x", "v"), null);
  assert.match(validate(schemaFor("", "string"), 1, "v")!, /^v: expected string, got number$/);
  assert.match(validate(schemaFor("", "number"), Number.NaN, "v")!, /expected number/);
  assert.equal(validate(schemaFor("", "boolean"), false, "v"), null);
  assert.equal(validate(schemaFor("", '"a" | "b"'), "b", "v"), null);
  assert.match(validate(schemaFor("", '"a" | "b"'), "c", "v")!, /expected "a" \| "b"/);
  assert.equal(validate(schemaFor("", "unknown"), { anything: [1] }, "v"), null);
});

test("enums accept their member values only", () => {
  const schema = schemaFor("enum Color { Red = 'red', Blue = 'blue' }", "Color");
  assert.equal(validate(schema, "red", "v"), null);
  assert.ok(validate(schema, "green", "v"));
});

test("recursive interfaces validate nested values", () => {
  const schema = schemaFor("interface Node { name: string; children?: Node[] }", "Node");
  assert.equal(validate(schema, { name: "a", children: [{ name: "b", children: [] }] }, "v"), null);
  assert.equal(validate(schema, { name: "a", children: [{ name: 1 }] }, "v"), "v.children[0].name: expected string, got number");
});

test("intersections combine properties", () => {
  const schema = schemaFor("type A = { a: string }; type B = { b: number }", "A & B");
  assert.equal(validate(schema, { a: "x", b: 1 }, "v"), null);
  assert.equal(validate(schema, { a: "x" }, "v"), "v.b: required");
});

test("tuples check length and positions", () => {
  const schema = schemaFor("", "[string, number]");
  assert.equal(validate(schema, ["a", 1], "v"), null);
  assert.ok(validate(schema, ["a"], "v"));
  assert.equal(validate(schema, ["a", "b"], "v"), "v[1]: expected number, got string");
});

test("prototype-looking keys are treated as unexpected properties", () => {
  const schema = schemaFor("interface User { name: string }", "User");
  assert.equal(validate(schema, JSON.parse('{"name":"a","__proto__":{"admin":true}}'), "v"), "v.__proto__: unexpected property");
});

for (const [name, type] of [
  ["Date", "Date"],
  ["functions", "() => void"],
  ["Map", "Map<string, number>"],
  ["bigint", "bigint"],
] as const) {
  test(`${name} cannot be validated`, () => {
    assert.throws(() => schemaFor("", type), UnsupportedTypeError);
  });
}

test("generic type parameters cannot be validated", () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { strict: true } });
  const parameter = project.createSourceFile("g.ts", "export function g<T>(value: T) {}").getFunctionOrThrow("g").getParameters()[0];
  assert.throws(() => schemaFromType(parameter.getType(), parameter), UnsupportedTypeError);
});

test("unresolved types cannot be validated", () => {
  assert.throws(() => schemaFor("", "DoesNotExist"), /unresolved type/);
});
