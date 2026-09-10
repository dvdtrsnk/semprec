/**
 * Issue #214's system-prompt projection: the sole hand-written guidance source is a
 * project's `project_agent_guidance` row, loaded through an injected port so this file never
 * imports `pg`, a pool singleton, or `@semprec/data`'s concrete store — only the composition
 * root (`services/semprec-agents`) knows how guidance is actually persisted.
 */

const PROJECT_GUIDANCE_HEADING = "## Project-specific guidance";

/** Port supplied by the process composition root — typically `service.loadProjectAgentGuidance`. */
export type LoadProjectAgentGuidancePort = (projectItemId: string) => Promise<{ markdown: string } | null>;

/**
 * Loads `projectItemId`'s guidance once and returns a synchronous `systemPromptOverride`
 * (pi-agent-core's/`AgentSessionOptions`'s hook shape) that appends its `markdown` verbatim
 * under the fixed `## Project-specific guidance` heading. Returns the identity function when
 * no guidance exists for the project — no other file or generated content is ever appended
 * as guidance.
 */
export async function createProjectAgentGuidanceSystemPromptOverride(
  loadProjectAgentGuidance: LoadProjectAgentGuidancePort,
  projectItemId: string,
): Promise<(defaultPrompt: string) => string> {
  const guidance = await loadProjectAgentGuidance(projectItemId);
  if (!guidance) {
    return (defaultPrompt) => defaultPrompt;
  }
  return (defaultPrompt) => `${defaultPrompt}\n\n${PROJECT_GUIDANCE_HEADING}\n\n${guidance.markdown}`;
}
