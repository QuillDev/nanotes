import { treaty } from "@elysiajs/eden";
import type { App } from "../../server/api.ts";

/** Typed client for the sync server's REST API; request and response shapes come from the server. */
export function apiClient(origin: string, fetcher?: typeof fetch) {
  return treaty<App>(origin, {
    parseDate: false,
    fetch: { credentials: "same-origin" },
    ...(fetcher ? { fetcher } : {}),
  }).api;
}

export type ApiClient = ReturnType<typeof apiClient>;

/** The server's `{ error }` message from a failed call, or `fallback`. */
export function failure(error: { value: unknown } | null, fallback: string): string {
  const value = error?.value;
  if (typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" && value.error) {
    return value.error;
  }
  return fallback;
}

/** A path segment for an id or note path. */
export const segment = (value: string) => encodeURIComponent(value);
