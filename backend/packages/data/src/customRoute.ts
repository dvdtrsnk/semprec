import { z } from "zod";
import { ValidationError } from "./errors.js";

// The parts of `semprec-api`'s custom-route request a handler in this package can read, typed structurally so the
// package imports no HTTP types. A handler's context intersects exactly the parts it reads, e.g.
// `RouteParams & RouteBody & RouteUser`.

export interface RouteParams {
  params: Record<string, string>;
}

export interface RouteBody {
  body: unknown;
}

export interface RouteUser {
  identity: { user: { id: string } };
}

export interface RouteLocale {
  identity: { user: { locale: string } };
}

export interface RouteSession {
  identity: { session: { id: string } };
}

export interface RouteUrl {
  req: { url?: string };
}

export interface RouteHeaders {
  req: { headers: Record<string, string | string[] | undefined> };
}

/** A custom route's JSON answer, sent as-is. */
export interface CustomRouteResult<T = unknown> {
  status: number;
  body: T;
}

const uuidSchema = z.uuid();

/** A malformed id is a 400 on its field here, not a 500 from a `uuid` column. */
export function requireUuidParam(params: Record<string, string>, name: string): string {
  const parsed = uuidSchema.safeParse(params[name]);
  if (!parsed.success) throw new ValidationError(`'${name}' must be a UUID string`, { field: name });
  return parsed.data;
}

/** The request URL, for its query parameters. */
export function requestUrl(req: { url?: string }): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

export function requireBodyObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
