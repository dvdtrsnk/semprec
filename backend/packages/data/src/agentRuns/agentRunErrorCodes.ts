export const AGENT_RUN_ERROR_CODES = ["budgetExceeded", "modelError", "cancelled", "interrupted", "internal"] as const;
export type AgentRunErrorCode = (typeof AGENT_RUN_ERROR_CODES)[number];

function isAgentRunErrorCode(value: unknown): value is AgentRunErrorCode {
  return typeof value === "string" && (AGENT_RUN_ERROR_CODES as readonly string[]).includes(value);
}

export class AgentRunError extends Error {
  readonly agentRunErrorCode: AgentRunErrorCode;

  constructor(agentRunErrorCode: AgentRunErrorCode, message: string) {
    super(message);
    this.name = "AgentRunError";
    this.agentRunErrorCode = agentRunErrorCode;
  }
}

/** The message never carries provider or request text. */
export class AiBudgetExceededError extends AgentRunError {
  constructor() {
    super("budgetExceeded", "AI budget exceeded");
    this.name = "AiBudgetExceededError";
  }
}

/** Any value that is not an `AgentRunError` is `internal`. */
export function agentRunErrorCodeOf(err: unknown): AgentRunErrorCode {
  if (typeof err === "object" && err !== null && "agentRunErrorCode" in err) {
    const code: unknown = err.agentRunErrorCode;
    if (isAgentRunErrorCode(code)) return code;
  }
  return "internal";
}
