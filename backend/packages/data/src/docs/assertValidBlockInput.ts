import { validateBlockInput, type BlockInput } from "@alldots/block-model";
import { ValidationError } from "../errors.js";

export function assertValidBlockInput(input: unknown): asserts input is BlockInput {
  const issues = validateBlockInput(input);
  if (issues.length > 0) {
    throw new ValidationError("Invalid block", { issues });
  }
}
