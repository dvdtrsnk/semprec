/**
 * The one caller-identity shape every generic-operation binding receives (issue #252). A REST
 * human actor is derived from the authenticated session context and omits the agent fields
 * (#219); an agent actor's `runId`/`agentProjectItemId` are derived by the AgentTool/MCP
 * composition root (#220), never accepted from a request body — every external input schema in
 * `schemas.ts` is a strict object with none of these field names, so a spoofed value fails
 * validation instead of reaching here.
 */
export interface AuthenticatedActor {
  userId: string;
  runId?: string;
  agentProjectItemId?: string;
}
