/**
 * The subset of a Zod issue `validationIssueField` reads. An `invalid_union` issue carries one issue array per union
 * member, in declaration order, in `errors`.
 */
export interface ValidationIssueLike {
  readonly code?: string;
  readonly path: readonly PropertyKey[];
  readonly errors?: readonly (readonly ValidationIssueLike[])[];
  readonly params?: Readonly<Record<string, unknown>>;
}

function joinPath(path: readonly PropertyKey[]): string {
  return path.map(String).join(".");
}

function isRelationPathFilterIssue(issue: ValidationIssueLike): boolean {
  return (
    (issue.code === "custom" && issue.params?.relationPathFilter === true) ||
    (issue.errors?.some((member) => member.some(isRelationPathFilterIssue)) ?? false)
  );
}

/**
 * The `field` a validation failure names: the first issue's `path` joined with `.` (`undefined` when empty). Zod emits
 * a path-less `invalid_union` only when every member failed with an aborting issue; then the member with the fewest
 * issues (first on a tie) is taken as the intended one, and its first issue with a non-empty path names the field. A
 * malformed `relation_path_contains` condition names `filter`, as its query contract requires, also inside nested trees
 * and unions; a marker on a sibling does not override it.
 */
export function validationIssueField(issues: readonly ValidationIssueLike[]): string | undefined {
  const firstIssue = issues[0];
  if (firstIssue === undefined) return undefined;
  if (
    isRelationPathFilterIssue(firstIssue) ||
    issues.some(
      (issue) =>
        issue.code === "custom" &&
        issue.params?.relationPathFilter === true &&
        issue.path.length <= firstIssue.path.length &&
        issue.path.every((part, index) => part === firstIssue.path[index]),
    )
  )
    return "filter";
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
