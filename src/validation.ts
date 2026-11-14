import { ts, type Node, type Type } from "ts-morph";

export type Schema =
  | { kind: "any" }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "null" }
  | { kind: "undefined" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "array"; items: Schema }
  | { kind: "tuple"; items: Schema[] }
  | { kind: "union"; options: Schema[] }
  | { kind: "object"; properties: Map<string, PropertySchema>; indexValue: Schema | null };

interface PropertySchema {
  schema: Schema;
  optional: boolean;
}

export class UnsupportedTypeError extends Error {}

export function schemaFromType(type: Type, location: Node, seen = new Map<ts.Type, Schema>()): Schema {
  const known = seen.get(type.compilerType);
  if (known) return known;

  if ((type.compilerType as { intrinsicName?: string }).intrinsicName === "error") {
    throw new UnsupportedTypeError(`unresolved type ${type.getText()}`);
  }
  if (type.isAny() || type.isUnknown()) return { kind: "any" };
  if (type.isString() || type.isTemplateLiteral()) return { kind: "string" };
  if (type.isNumber()) return { kind: "number" };
  if (type.isBoolean()) return { kind: "boolean" };
  if (type.isNull()) return { kind: "null" };
  if (type.isUndefined() || type.isVoid()) return { kind: "undefined" };
  if (type.isBooleanLiteral()) return { kind: "literal", value: type.getText() === "true" };
  if (type.isStringLiteral() || type.isNumberLiteral() || type.isEnumLiteral()) {
    const value = type.getLiteralValue();
    if (typeof value === "string" || typeof value === "number") return { kind: "literal", value };
  }
  if (type.isUnion()) {
    const union: Schema = { kind: "union", options: [] };
    seen.set(type.compilerType, union);
    union.options = type.getUnionTypes().map((member) => schemaFromType(member, location, seen));
    return union;
  }
  if (type.isTypeParameter()) throw new UnsupportedTypeError(`generic type parameter ${type.getText()}`);
  if (type.isArray() || type.isReadonlyArray()) {
    const array: Schema = { kind: "array", items: { kind: "any" } };
    seen.set(type.compilerType, array);
    const element = type.getArrayElementType() ?? type.getTypeArguments()[0];
    if (!element) throw new UnsupportedTypeError(type.getText());
    array.items = schemaFromType(element, location, seen);
    return array;
  }
  if (type.isTuple()) {
    const tuple: Schema = { kind: "tuple", items: [] };
    seen.set(type.compilerType, tuple);
    tuple.items = type.getTupleElements().map((element) => schemaFromType(element, location, seen));
    return tuple;
  }
  if (type.isObject() || type.isIntersection()) return objectSchema(type, location, seen);

  throw new UnsupportedTypeError(type.getText());
}

function objectSchema(type: Type, location: Node, seen: Map<ts.Type, Schema>): Schema {
  if (type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0) {
    throw new UnsupportedTypeError(`function type ${type.getText()}`);
  }
  const object: Schema = { kind: "object", properties: new Map(), indexValue: null };
  seen.set(type.compilerType, object);

  for (const property of type.getProperties()) {
    const propertyType = property.getTypeAtLocation(location);
    if (propertyType.getCallSignatures().length > 0) {
      throw new UnsupportedTypeError(`${type.getText()} (it has methods, so it is not plain JSON data)`);
    }
    object.properties.set(property.getName(), {
      schema: schemaFromType(propertyType, location, seen),
      optional: (property.getFlags() & ts.SymbolFlags.Optional) !== 0,
    });
  }
  const indexType = type.getStringIndexType();
  if (indexType) object.indexValue = schemaFromType(indexType, location, seen);
  return object;
}

export function validate(schema: Schema, value: unknown, path: string): string | null {
  switch (schema.kind) {
    case "any":
      return null;
    case "string":
    case "boolean":
    case "undefined":
      return typeof value === schema.kind ? null : mismatch(schema, value, path);
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? null : mismatch(schema, value, path);
    case "null":
      return value === null ? null : mismatch(schema, value, path);
    case "literal":
      return value === schema.value ? null : mismatch(schema, value, path);
    case "union":
      return validateUnion(schema, value, path);
    case "array":
      if (!Array.isArray(value)) return mismatch(schema, value, path);
      return firstError(value.map((item, index) => validate(schema.items, item, `${path}[${index}]`)));
    case "tuple":
      if (!Array.isArray(value) || value.length !== schema.items.length) return mismatch(schema, value, path);
      return firstError(schema.items.map((item, index) => validate(item, value[index], `${path}[${index}]`)));
    case "object":
      return validateObject(schema, value, path);
  }
}

/** When exactly one option has the value's shape (array or object), its nested error is the useful one. */
function validateUnion(schema: Extract<Schema, { kind: "union" }>, value: unknown, path: string): string | null {
  const errors = schema.options.map((option) => validate(option, value, path));
  if (errors.includes(null)) return null;
  const shapeKinds = Array.isArray(value) ? ["array", "tuple"] : typeof value === "object" && value ? ["object"] : [];
  const sameShape = schema.options.flatMap((option, index) => (shapeKinds.includes(option.kind) ? [errors[index]] : []));
  return sameShape.length === 1 ? sameShape[0] : mismatch(schema, value, path);
}

function validateObject(schema: Extract<Schema, { kind: "object" }>, value: unknown, path: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return mismatch(schema, value, path);
  const record = value as Record<string, unknown>;
  for (const [name, property] of schema.properties) {
    const propertyValue = Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
    if (propertyValue === undefined) {
      if (property.optional) continue;
      return `${path}.${name}: required`;
    }
    const error = validate(property.schema, propertyValue, `${path}.${name}`);
    if (error) return error;
  }
  for (const name of Object.keys(record)) {
    if (schema.properties.has(name)) continue;
    if (!schema.indexValue) return `${path}.${name}: unexpected property`;
    const error = validate(schema.indexValue, record[name], `${path}.${name}`);
    if (error) return error;
  }
  return null;
}

function firstError(errors: (string | null)[]): string | null {
  return errors.find((error) => error !== null) ?? null;
}

function mismatch(schema: Schema, value: unknown, path: string): string {
  return `${path}: expected ${describe(schema)}, got ${describeValue(value)}`;
}

function describe(schema: Schema): string {
  switch (schema.kind) {
    case "literal":
      return JSON.stringify(schema.value);
    case "union":
      return schema.options.map(describe).join(" | ");
    case "array":
      return "array";
    case "tuple":
      return `tuple of ${schema.items.length}`;
    default:
      return schema.kind;
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
