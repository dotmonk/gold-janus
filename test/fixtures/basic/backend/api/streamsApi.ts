import { once } from "node:events";
import { ApiError, nextEvent, requestSignal } from "gold-janus";

const neverFires = new EventTarget();
const pings = new EventTarget();
let startedWaits = 0;
let finishedWaits = 0;
let finishedPingWaits = 0;

export async function* streamPings(): AsyncGenerator<string> {
  try {
    yield "ready";
    while (true) {
      const ping = await nextEvent<CustomEvent<string>>(pings, "ping");
      yield ping.detail;
    }
  } finally {
    finishedPingWaits++;
  }
}

export async function ping(message: string): Promise<void> {
  pings.dispatchEvent(new CustomEvent("ping", { detail: message }));
}

export async function finishedPingWaitCount(): Promise<number> {
  return finishedPingWaits;
}

export async function* countFrom(start: number): AsyncGenerator<number> {
  yield start;
  yield start + 1;
}

export async function* waitUntilDisconnect(): AsyncGenerator<string> {
  startedWaits++;
  try {
    yield "ready";
    await once(neverFires, "never", { signal: requestSignal() });
  } finally {
    finishedWaits++;
  }
}

export async function finishedWaitCount(): Promise<number> {
  return finishedWaits;
}

export async function runningWaitCount(): Promise<number> {
  return startedWaits - finishedWaits;
}

export async function* failAfterFirst(): AsyncGenerator<string> {
  yield "first";
  throw new ApiError(409, "stream conflict");
}

export async function* crashAfterFirst(): AsyncGenerator<string> {
  yield "first";
  throw new Error("secret stream detail");
}
