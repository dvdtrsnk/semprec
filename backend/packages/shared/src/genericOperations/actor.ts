/**
 * The one authenticated-caller shape every generic operation is invoked with. It is never
 * part of an operation's input schema: adapters derive it from the authenticated session
 * (REST) or from the agent run (AgentTool/MCP) and inject it server-side, so a caller
 * cannot influence authorization by putting identity fields in a request body.
 */
export interface AuthenticatedActor {
  userId: string;
  runId?: string;
  agentProjectItemId?: string;
}
