import type { RequestHandler } from "express";

const ALLOWED_HEADERS = "Content-Type, X-Gold-Method";
const PREFLIGHT_CACHE_SECONDS = "600";

/** Throws unless every entry is an exact origin such as `https://app.example.com`. */
export function checkCorsOrigins(origins: string[]): void {
  for (const origin of origins) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(origin);
    } catch {
      // reported below
    }
    if (!parsed || parsed.origin !== origin) {
      throw new Error(`Gild: corsOrigins entry "${origin}" must be an exact origin like "https://app.example.com"`);
    }
  }
}

/** CORS for `/gold_*`: listed origins may call with credentials; everyone else gets no CORS headers. */
export function corsForOrigins(origins: string[]): RequestHandler {
  const allowed = new Set(origins);
  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.get("Origin");
    const isAllowed = origin !== undefined && allowed.has(origin);
    if (isAllowed) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Credentials", "true");
    }
    if (req.method !== "OPTIONS") {
      next();
      return;
    }
    if (isAllowed) {
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
      res.set("Access-Control-Max-Age", PREFLIGHT_CACHE_SECONDS);
    }
    res.status(204).end();
  };
}
