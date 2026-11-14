// Shared helpers of the generated client; gold-janus prepends `const _base = "…";`.

async function _error(response) {
  let message = "HTTP " + response.status;
  try {
    const body = await response.json();
    if (body && typeof body.error === "string") message = body.error;
  } catch {}
  const error = new Error(message);
  error.status = response.status;
  return error;
}

async function _call(method, body) {
  const headers = { "X-Gold-Method": method };
  if (!(body instanceof FormData)) headers["Content-Type"] = "application/json";
  const response = await fetch(_base + "/gold_request", { method: "POST", headers, body });
  if (!response.ok) throw await _error(response);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function _form(files, fields) {
  const form = new FormData();
  for (const [name, value] of Object.entries(files)) {
    if (value == null) continue;
    for (const file of Array.isArray(value) ? value : [value]) form.append(name, file);
  }
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(name, JSON.stringify(value));
  }
  return form;
}

function _stream(method, args, callback, onError) {
  const controller = new AbortController();
  let delay = 1000;
  let timer;
  const report = (error) => { if (onError) onError(error); };
  const deliver = (data) => {
    try { callback(data); } catch (error) { setTimeout(() => { throw error; }); }
  };
  const connect = async () => {
    let reconnect = true;
    let reported = false;
    try {
      const response = await fetch(_base + "/gold_sse", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gold-Method": method },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        reconnect = response.status >= 500;
        throw await _error(response);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          let event = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event: ")) event = line.slice(7);
            else if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (!data) continue;
          const payload = JSON.parse(data);
          if (event === "end") {
            reconnect = false;
          } else if (event === "error") {
            const error = new Error(payload.error);
            error.status = payload.status;
            if (payload.status < 500) reconnect = false;
            reported = true;
            report(error);
          } else {
            delay = 1000;
            deliver(payload);
          }
        }
      }
      if (reconnect && !reported) report(new Error("Stream closed"));
    } catch (error) {
      if (controller.signal.aborted) return;
      report(error instanceof Error ? error : new Error(String(error)));
    }
    if (!reconnect || controller.signal.aborted) return;
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  };
  controller.signal.addEventListener("abort", () => clearTimeout(timer));
  connect();
  return () => controller.abort();
}
