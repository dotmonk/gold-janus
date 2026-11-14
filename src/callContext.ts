import { AsyncLocalStorage } from "async_hooks";
import { once } from "events";

export const callContext = new AsyncLocalStorage<{ signal: AbortSignal }>();

/**
 * AbortSignal for the API call or stream currently running; it aborts when the client
 * disconnects. Pass it to waits such as `once(target, "event", { signal })`.
 */
export function requestSignal(): AbortSignal {
  const context = callContext.getStore();
  if (!context) throw new Error("requestSignal() can only be called while gold-janus is running an API call");
  return context.signal;
}

/**
 * Waits for the next `type` event on `target` inside an API call or stream. When the client
 * disconnects the wait rejects, so a stream generator stops instead of waiting on.
 */
export async function nextEvent<E extends Event = Event>(target: EventTarget, type: string): Promise<E> {
  const [event] = (await once(target, type, { signal: requestSignal() })) as [E];
  return event;
}
