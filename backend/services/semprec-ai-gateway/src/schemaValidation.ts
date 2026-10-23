import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";

/**
 * Issue #215: caller-supplied `responseSchema` is bounded at 64 KiB (arbitrary caller-controlled
 * JSON validated on every request; unbounded would make this route a cheap way to burn CPU on
 * a pathologically large schema) and forbidden from resolving a remote `$ref` (this process has
 * no business making an outbound fetch to satisfy a caller's schema, and a local ref that only
 * points inside the same document, `#/...`, is the only kind that's ever needed).
 */
export const MAX_RESPONSE_SCHEMA_BYTES = 64 * 1024;

export class InvalidResponseSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidResponseSchemaError";
  }
}

function assertNoRemoteRef(node: unknown, path: string): void {
  if (Array.isArray(node)) {
    node.forEach((item, index) => assertNoRemoteRef(item, `${path}/${index}`));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) {
        throw new InvalidResponseSchemaError(`responseSchema contains a remote $ref at ${path}/${key}`);
      }
      assertNoRemoteRef(value, `${path}/${key}`);
    }
  }
}

const ajv = new Ajv2020({ strict: false });

/**
 * Enforces size and remote-`$ref` constraints, then compiles the schema as Draft 2020-12.
 * Throws `InvalidResponseSchemaError` for any failure — the route handler maps this to
 * `400 validation_failed`.
 */
export function compileResponseSchema(schema: unknown): ValidateFunction {
  if (schema === null || typeof schema !== "object") {
    throw new InvalidResponseSchemaError("responseSchema must be a JSON object");
  }

  const serializedSize = Buffer.byteLength(JSON.stringify(schema), "utf8");
  if (serializedSize > MAX_RESPONSE_SCHEMA_BYTES) {
    throw new InvalidResponseSchemaError(
      `responseSchema exceeds the maximum size of ${MAX_RESPONSE_SCHEMA_BYTES} bytes`,
    );
  }

  assertNoRemoteRef(schema, "#");

  try {
    return ajv.compile(schema);
  } catch (err) {
    throw new InvalidResponseSchemaError(
      `responseSchema is not a valid Draft 2020-12 JSON Schema: ${err instanceof Error ? err.message : "unknown error"}`,
    );
  }
}
