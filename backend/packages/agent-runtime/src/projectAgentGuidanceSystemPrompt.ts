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
 *
 * The markdown is appended unsanitized, so a project owner can write adversarial content
 * (e.g. an instruction override) into their own project's guidance. This is an accepted risk,
 * not an oversight: only the project's own owner can write this field (enforced by
 * `ProjectAgentGuidanceService`'s authorization check), so the threat model is the same as any
 * other owner-authored project configuration — it bounds a project owner's ability to influence
 * their own project's agent, not a third party's. `MAX_PROJECT_AGENT_GUIDANCE_MARKDOWN_BYTES`
 * bounds the payload size, not its content.
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
