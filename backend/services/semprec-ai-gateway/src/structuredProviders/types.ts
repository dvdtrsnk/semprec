/**
 * Issue #215: the registry of providers `POST /internal/complete` may dispatch to. Kept inside
 * `semprec-ai-gateway` — never `packages/ai-gateway` or any other package — so no model-provider
 * dependency exists outside this one process (the issue's acceptance criterion).
 */

export interface StructuredCompletionMessage {
  role: "user" | "assistant";
  content: string;
}

export interface StructuredCompletionRequest {
  model: string;
  temperature: number;
  system: string;
  messages: StructuredCompletionMessage[];
  /** Already validated (Draft 2020-12, no remote `$ref`, <= 64 KiB) by the route handler. */
  responseSchema: object;
}

export interface StructuredCompletionResponse {
  /** The provider's raw structured output; the route handler validates this against the schema. */
  content: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** Thrown by a provider adapter for any transport-level failure — network error or non-2xx. */
export class ProviderCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderCallError";
  }
}

export interface StructuredCompletionProvider {
  id: string;
  /**
   * Startup requires this to be `true` for `AI_GATEWAY_STRUCTURED_PROVIDER` (#215's "the provider
   * id must exist in the registry and advertise native JSON-Schema structured output").
   */
  supportsJsonSchemaStructuredOutput: boolean;
  complete(request: StructuredCompletionRequest): Promise<StructuredCompletionResponse>;
}

export interface StructuredProviderRegistry {
  get(id: string): StructuredCompletionProvider | undefined;
}

export function createStructuredProviderRegistry(
  providers: StructuredCompletionProvider[],
): StructuredProviderRegistry {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  return {
    get(id: string) {
      return byId.get(id);
    },
  };
}
