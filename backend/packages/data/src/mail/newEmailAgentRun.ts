// What `core.agentRun` needs from the mail module for the `newEmail` heartbeat (issue gh-1941): the run project resolvers
// that its `runProject` config names and the gate of its `answerExpectedFilter` config. `coreAgentRunAction` cannot
// import them (`scheduler/actions.ts` is imported by the choke point, which the mail module imports), so the composition
// root of the agents process passes them in.
import type { Pool } from "pg";
import type { AiGatewayClientPort } from "@semprec/shared";
import type { CoreAgentRunDependencies } from "../scheduler/actions.js";
import { createAnswerExpectedGate } from "../scheduler/answerExpectedFilter.js";
import { resolveMailThreadRunProject } from "./newEmailRunProject.js";

/**
 * The `CoreAgentRunDependencies` of a composition root: the resolver `mailThreadProject`, and the answer-expected gate when
 * a `gateway` is given. Without one the action has no gate, and a heartbeat that turns `answerExpectedFilter` on fails
 * when it fires.
 */
export function createNewEmailAgentRunDependencies(
  pool: Pool,
  gateway?: AiGatewayClientPort,
): CoreAgentRunDependencies {
  return {
    runProjectResolvers: { mailThreadProject: (input) => resolveMailThreadRunProject(pool, input) },
    ...(gateway === undefined ? {} : { answerExpectedGate: createAnswerExpectedGate(pool, gateway) }),
  };
}
