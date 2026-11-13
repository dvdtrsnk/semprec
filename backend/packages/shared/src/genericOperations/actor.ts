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
  /**
   * Set only by the REST adapter's `restActor`: the actor is a human on an authenticated browser
   * session. The MCP and AgentTool composition roots never set it, and no input schema accepts it.
   */
  restSession?: true;
  /**
   * Set only by the `/mcp` endpoint for a caller on the user's own bearer token or session, an external AI client
   * (issue #1998): a sensitive database is refused to it. No run credential, the REST adapter and the AgentTool
   * composition root set it, and no input schema accepts it.
   */
  externalClient?: true;
}
