/**
 * The subset of a Zod issue `validationIssueField` reads. An `invalid_union` issue carries one
 * array of issues per union member, in declaration order, in `errors`.
 */
export interface ValidationIssueLike {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly errors?: readonly (readonly ValidationIssueLike[])[];
}

function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

/**
 * The `field` a validation failure should name. For a first issue that is not `invalid_union` it
 * is that issue's `path` joined with `.` (`undefined` when the path is empty). Zod only emits a
 * path-less `invalid_union` when every member failed with an aborting issue, so for one the
 * member with the fewest issues (the first in declaration order on a tie) is taken as the one
 * the caller meant, and the field is that member's first issue with a non-empty path —
 * `undefined` when it has none.
 */
export function validationIssueField(issues: readonly ValidationIssueLike[]): string | undefined {
  const firstIssue = issues[0];
  if (firstIssue === undefined) return undefined;
  if (firstIssue.code !== "invalid_union" || firstIssue.errors === undefined) {
    return firstIssue.path.length > 0 ? joinPath(firstIssue.path) : undefined;
  }
  let chosen: readonly ValidationIssueLike[] | undefined;
  for (const member of firstIssue.errors) {
    if (chosen === undefined || member.length < chosen.length) chosen = member;
  }
  const pathBearing = chosen?.find((issue) => issue.path.length > 0);
  return pathBearing === undefined ? undefined : joinPath(pathBearing.path);
}
