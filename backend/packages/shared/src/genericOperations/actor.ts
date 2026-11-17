/**
 * The caller identity every generic-operation binding receives. A REST human actor comes from the authenticated
 * session; an agent actor's `runId`/`agentProjectItemId` come from the AgentTool/MCP composition root. Never accepted
 * from a request body: input schemas are strict objects without these fields.
 */
export interface AuthenticatedActor {
  userId: string;
  runId?: string;
  agentProjectItemId?: string;
  /**
   * Set only by the REST adapter's `restActor` for a human on an authenticated browser session; no input schema accepts
   * it.
   */
  restSession?: true;
  /**
   * Set only by `/mcp` for an external AI client on the user's own bearer token or session; sensitive databases are
   * refused to it. No input schema accepts it.
   */
  externalClient?: true;
}
