import type { IncomingMessage } from "node:http";
import { ValidationError } from "@semprec/data";

/**
 * Shared request-shape validators for routes built on this adapter (issue #238) — path
 * parameters, query parameters, headers, and JSON bodies all fail the same way, with
 * `validation_failed`, so a caller can rely on one error shape regardless of which part of the
 * request was malformed.
 */

export function requireStringParam(params: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Missing required path parameter '${name}'`, { field: name });
  }
  return value;
}

export function requireStringQueryParam(query: URLSearchParams, name: string): string {
  const value = query.get(name);
  if (value === null || value.length === 0) {
    throw new ValidationError(`Missing required query parameter '${name}'`, { field: name });
  }
  return value;
}

export function optionalStringQueryParam(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name);
  return value === null ? undefined : value;
}

export function requireHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`Missing required header '${name}'`, { field: name });
  }
  return value;
}

/** Rejects anything but a plain JSON object — an array, string, number, `null`, or non-JSON body is `validation_failed`. */
export function requireJsonObjectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function requireStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ValidationError(`'${field}' must be a non-empty string`, { field });
  }
  return value;
}

/** Postgres's `integer` column type holds values in this range; a body field backing one must fail as 400, not reach the database and surface as a raw DB error. */
export const POSTGRES_INT4_MIN = -2147483648;
export const POSTGRES_INT4_MAX = 2147483647;

export interface IntegerFieldOptions {
  /** Also reject negative values, for a column that only ever holds a non-negative integer (e.g. a position). */
  nonNegative?: boolean;
}

function integerFieldRange(options: IntegerFieldOptions): { min: number; max: number } {
  return { min: options.nonNegative ? 0 : POSTGRES_INT4_MIN, max: POSTGRES_INT4_MAX };
}

/** `Number.isInteger` already excludes `NaN` and `Infinity`, so this one check covers integer, finite, and (with the range test) in-bounds. */
function assertIntegerField(value: unknown, field: string, options: IntegerFieldOptions): number {
  const { min, max } = integerFieldRange(options);
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(`'${field}' must be an integer between ${min} and ${max}`, { field });
  }
  return value;
}

export function requireIntegerField(
  body: Record<string, unknown>,
  field: string,
  options: IntegerFieldOptions = {},
): number {
  return assertIntegerField(body[field], field, options);
}

export function optionalIntegerField(
  body: Record<string, unknown>,
  field: string,
  options: IntegerFieldOptions = {},
): number | undefined {
  const value = body[field];
  return value === undefined ? undefined : assertIntegerField(value, field, options);
}
