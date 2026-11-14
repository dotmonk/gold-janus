import { ApiError } from "gold-janus";
import type { Item, Status } from "../models/item";

let addItemCalls = 0;

export async function addItem(item: Item): Promise<Item> {
  addItemCalls++;
  return item;
}

export async function addItemCallCount(): Promise<number> {
  return addItemCalls;
}

export async function setStatus(id: number, status: Status, note?: string): Promise<string> {
  return `${id}:${status}:${note ?? ""}`;
}

export async function setNullable(value: string | null): Promise<string | null> {
  return value;
}

export async function countLabels(labels: Record<string, number>): Promise<number> {
  return Object.keys(labels).length;
}

export async function textLength(text: string): Promise<number> {
  return text.length;
}

export async function fail(kind: "api" | "crash"): Promise<void> {
  if (kind === "api") throw new ApiError(409, "Already exists");
  throw new Error("secret internal detail");
}
