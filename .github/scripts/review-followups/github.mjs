/**
 * GitHub access layer shared by the review follow-ups scripts (harvest, triage
 * `prepare` and triage `publish`): one `fetch`-based transport plus thin endpoint
 * functions, so none of those scripts hand-rolls pagination or error handling.
 *
 * Environment variables, read by `clientFromEnv`:
 *   GITHUB_API_URL     — REST base URL (default `https://api.github.com`)
 *   GITHUB_GRAPHQL_URL — GraphQL endpoint (default `<GITHUB_API_URL>/graphql`)
 *   GITHUB_TOKEN       — bearer token (required)
 *   GITHUB_REPOSITORY  — `owner/name` (required)
 *
 * They are set in two environments:
 *   - GitHub Actions: the runner sets GITHUB_API_URL, GITHUB_GRAPHQL_URL and
 *     GITHUB_REPOSITORY; the workflow passes GITHUB_TOKEN.
 *   - Relay command steps: Relay's loopback token proxy sets all four. The API URLs
 *     point at `http://127.0.0.1:<port>` and GITHUB_TOKEN is a placeholder the proxy
 *     replaces with the Relay App's real token.
 *
 * GitHub is reached only through these variables with `fetch` — the `gh` CLI ignores
 * GITHUB_API_URL for github.com and would bypass the proxy.
 *
 * Every non-2xx response is a throw (the one exception is `removeLabel`'s 404), and
 * every endpoint function checks the response against the shape it reads: a half-read
 * repository must never look like an empty one. Retries and rate-limit back-off are
 * deliberately absent — a failed call fails the run, which is re-run later.
 *
 * Authors are always returned in REST form (`github-actions[bot]`), because GraphQL
 * reports a bot's login without the `[bot]` suffix.
 */

const DEFAULT_API_URL = "https://api.github.com";
const MAX_PAGES = 100;
const ERROR_TEXT_LIMIT = 300;
const REQUEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Shape checks for everything read from a response.

function fail(what, detail) {
  throw new Error(`Unexpected GitHub response: ${what} ${detail}`);
}

function object(value, what) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(what, "is not an object");
  return value;
}

function array(value, what) {
  if (!Array.isArray(value)) fail(what, "is not an array");
  return value;
}

function integer(value, what) {
  if (!Number.isSafeInteger(value)) fail(what, "is not an integer");
  return value;
}

function string(value, what) {
  if (typeof value !== "string") fail(what, "is not a string");
  return value;
}

function stringOrNull(value, what) {
  return value === null ? null : string(value, what);
}

function boolean(value, what) {
  if (typeof value !== "boolean") fail(what, "is not a boolean");
  return value;
}

function labelNames(value, what) {
  return array(value, what).map((label, i) => string(object(label, `${what}[${i}]`).name, `${what}[${i}].name`));
}

/** Arguments that end up in a URL path: a caller bug must not turn into a request for some other resource. */
function issueNumber(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

function nonEmpty(value, name) {
  if (typeof value !== "string" || value === "") throw new Error(`${name} must be a non-empty string`);
  return value;
}

// ---------------------------------------------------------------------------
// Transport.

/** The URL of the `rel="next"` entry of a `Link` header, or null when there is none. */
function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = /<([^>]*)>\s*;\s*rel="?next"?/.exec(part);
    if (match) return match[1];
  }
  return null;
}

export function createGitHubClient({ apiUrl, graphqlUrl, token, repository, fetchImpl = fetch }) {
  const apiOrigin = new URL(apiUrl).origin;

  /** Error text never carries the token, even when a response echoes it back. */
  const redact = (text) => (token ? text.split(token).join("[redacted]") : text);

  async function send(method, url, label, body) {
    const response = await fetchImpl(url, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = redact(await response.text()).slice(0, ERROR_TEXT_LIMIT);
      const error = new Error(`${method} ${label} failed (${response.status}): ${text}`);
      error.status = response.status;
      throw error;
    }
    const data = response.status === 204 ? null : await response.json();
    return { data, next: nextLink(response.headers.get("link")) };
  }

  async function request(method, path, { body } = {}) {
    return (await send(method, `${apiUrl}${path}`, path, body)).data;
  }

  /**
   * Every page of a listing, concatenated. `pick` extracts a page's items when the
   * endpoint wraps them in an object (a commit's `files`). A next link on another
   * origin is refused rather than followed, so the token is never sent anywhere but
   * the configured API.
   */
  async function paginate(path, { pick = (page) => page } = {}) {
    const items = [];
    let url = `${apiUrl}${path}`;
    let label = path;
    for (let page = 1; url; page += 1) {
      if (page > MAX_PAGES) throw new Error(`GET ${path} has more than ${MAX_PAGES} pages`);
      const { data, next } = await send("GET", url, label, undefined);
      const pageItems = pick(data);
      if (!Array.isArray(pageItems)) throw new Error(`GET ${label} returned a page that is not a JSON array`);
      items.push(...pageItems);
      if (next && new URL(next).origin !== apiOrigin) {
        throw new Error(`GET ${label} links its next page to another origin (${new URL(next).origin})`);
      }
      url = next;
      if (next) label = next.startsWith(apiUrl) ? next.slice(apiUrl.length) : next;
    }
    return items;
  }

  async function graphql(query, variables) {
    const { data: result } = await send("POST", graphqlUrl, "graphql", { query, variables });
    const envelope = object(result, "graphql response");
    if (envelope.errors !== undefined && envelope.errors !== null) {
      const errors = array(envelope.errors, "graphql errors");
      if (errors.length > 0) {
        const first = errors[0]?.message;
        throw new Error(`POST graphql returned ${errors.length} error(s): ${redact(String(first)).slice(0, ERROR_TEXT_LIMIT)}`);
      }
    }
    if (envelope.data === undefined || envelope.data === null) throw new Error("POST graphql returned no data");
    return envelope.data;
  }

  return { repository, request, paginate, graphql };
}

export function clientFromEnv(env = process.env) {
  const apiUrl = (env.GITHUB_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const graphqlUrl = env.GITHUB_GRAPHQL_URL || `${apiUrl}/graphql`;
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  const repository = env.GITHUB_REPOSITORY;
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error(`GITHUB_REPOSITORY must be "owner/name", got "${repository}"`);
  }
  return createGitHubClient({ apiUrl, graphqlUrl, token, repository });
}

// ---------------------------------------------------------------------------
// Read endpoints.

function toIssue(raw, what) {
  const issue = object(raw, what);
  return {
    number: integer(issue.number, `${what}.number`),
    id: integer(issue.id, `${what}.id`),
    state: string(issue.state, `${what}.state`),
    title: string(issue.title, `${what}.title`),
    body: stringOrNull(issue.body, `${what}.body`) ?? "",
    labels: labelNames(issue.labels, `${what}.labels`),
  };
}

/** Issues carrying `label`, pull requests excluded (they share the issues endpoint). */
export async function listIssuesWithLabel(client, label, state) {
  if (state !== "open" && state !== "all") throw new Error(`state must be "open" or "all", got "${state}"`);
  const query = new URLSearchParams({ labels: nonEmpty(label, "label"), state, per_page: "100" });
  const raw = await client.paginate(`/repos/${client.repository}/issues?${query}`);
  return raw
    .filter((entry) => object(entry, "issue").pull_request === undefined)
    .map((entry, i) => toIssue(entry, `issue[${i}]`));
}

export async function getIssue(client, number) {
  issueNumber(number, "number");
  return toIssue(await client.request("GET", `/repos/${client.repository}/issues/${number}`), `issue #${number}`);
}

/** A REST author's login; a deleted account comes back as `user: null`, reported as `ghost`. */
function restAuthor(user, what) {
  return user === null ? "ghost" : string(object(user, what).login, `${what}.login`);
}

export async function listIssueComments(client, number) {
  issueNumber(number, "number");
  const raw = await client.paginate(`/repos/${client.repository}/issues/${number}/comments?per_page=100`);
  return raw.map((entry, i) => {
    const comment = object(entry, `comment[${i}]`);
    return {
      id: integer(comment.id, `comment[${i}].id`),
      author: restAuthor(comment.user, `comment[${i}].user`),
      createdAt: string(comment.created_at, `comment[${i}].created_at`),
      body: stringOrNull(comment.body, `comment[${i}].body`) ?? "",
    };
  });
}

/** Closed pull requests into `base` that were merged, ascending by number. */
export async function listMergedPullRequests(client, base) {
  const query = new URLSearchParams({ state: "closed", base: nonEmpty(base, "base"), per_page: "100" });
  const raw = await client.paginate(`/repos/${client.repository}/pulls?${query}`);
  return raw
    .map((entry, i) => {
      const pr = object(entry, `pull[${i}]`);
      return {
        number: integer(pr.number, `pull[${i}].number`),
        mergedAt: stringOrNull(pr.merged_at, `pull[${i}].merged_at`),
        labels: labelNames(pr.labels, `pull[${i}].labels`),
      };
    })
    .filter((pr) => pr.mergedAt !== null)
    .sort((a, b) => a.number - b.number);
}

const REVIEW_THREADS_QUERY = `
query ($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { databaseId body author { __typename login } }
          }
        }
      }
    }
  }
}`;

/** GraphQL drops a bot's `[bot]` suffix; REST keeps it, and the pipeline compares REST logins. */
function graphqlAuthor(author, what) {
  if (author === null) return "ghost";
  const { __typename: type, login } = object(author, what);
  string(type, `${what}.__typename`);
  string(login, `${what}.login`);
  return type === "Bot" ? `${login}[bot]` : login;
}

export async function listReviewThreads(client, prNumber) {
  issueNumber(prNumber, "prNumber");
  const [owner, name] = client.repository.split("/");
  const threads = [];
  let cursor = null;
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw new Error(`review threads of #${prNumber} have more than ${MAX_PAGES} pages`);
    const data = await client.graphql(REVIEW_THREADS_QUERY, { owner, name, number: prNumber, cursor });
    const repo = object(data.repository, "repository");
    const pr = object(repo.pullRequest, `pullRequest #${prNumber}`);
    const connection = object(pr.reviewThreads, "reviewThreads");
    const pageInfo = object(connection.pageInfo, "reviewThreads.pageInfo");
    for (const [i, rawThread] of array(connection.nodes, "reviewThreads.nodes").entries()) {
      const what = `reviewThreads.nodes[${i}]`;
      const thread = object(rawThread, what);
      const comments = object(thread.comments, `${what}.comments`);
      if (boolean(object(comments.pageInfo, `${what}.comments.pageInfo`).hasNextPage, `${what}.comments.pageInfo.hasNextPage`)) {
        throw new Error(`a review thread on #${prNumber} has more than 100 comments`);
      }
      threads.push({
        isResolved: boolean(thread.isResolved, `${what}.isResolved`),
        comments: array(comments.nodes, `${what}.comments.nodes`).map((rawComment, j) => {
          const comment = object(rawComment, `${what}.comments.nodes[${j}]`);
          return {
            databaseId: integer(comment.databaseId, `${what}.comments.nodes[${j}].databaseId`),
            author: graphqlAuthor(comment.author, `${what}.comments.nodes[${j}].author`),
            body: string(comment.body, `${what}.comments.nodes[${j}].body`),
          };
        }),
      });
    }
    if (!boolean(pageInfo.hasNextPage, "reviewThreads.pageInfo.hasNextPage")) return threads;
    cursor = string(pageInfo.endCursor, "reviewThreads.pageInfo.endCursor");
  }
}

function refPath(ref) {
  return nonEmpty(ref, "ref").split("/").map(encodeURIComponent).join("/");
}

/** Every blob path of the tree at `ref`. A truncated tree is a throw, never a partial set. */
export async function listTreePaths(client, ref) {
  const tree = object(await client.request("GET", `/repos/${client.repository}/git/trees/${refPath(ref)}?recursive=1`), "tree");
  if (boolean(tree.truncated, "tree.truncated")) throw new Error(`the tree of ${ref} is truncated`);
  const paths = new Set();
  for (const [i, rawEntry] of array(tree.tree, "tree.tree").entries()) {
    const entry = object(rawEntry, `tree.tree[${i}]`);
    if (string(entry.type, `tree.tree[${i}].type`) === "blob") paths.add(string(entry.path, `tree.tree[${i}].path`));
  }
  return paths;
}

/** Commit SHAs in GitHub's order; GitHub itself lists at most 250 commits of a pull request. */
export async function listPullRequestCommits(client, prNumber) {
  issueNumber(prNumber, "prNumber");
  const raw = await client.paginate(`/repos/${client.repository}/pulls/${prNumber}/commits?per_page=100`);
  return raw.map((entry, i) => string(object(entry, `commit[${i}]`).sha, `commit[${i}].sha`));
}

/** Every `filename` and `previous_filename` of the commit, across all pages of its files. */
export async function getCommitFiles(client, sha) {
  const files = await client.paginate(
    `/repos/${client.repository}/commits/${encodeURIComponent(nonEmpty(sha, "sha"))}?per_page=100`,
    { pick: (page) => object(page, "commit").files },
  );
  const names = [];
  for (const [i, rawFile] of files.entries()) {
    const file = object(rawFile, `files[${i}]`);
    names.push(string(file.filename, `files[${i}].filename`));
    if (file.previous_filename !== undefined) names.push(string(file.previous_filename, `files[${i}].previous_filename`));
  }
  return names;
}

export async function listCommitsTouchingPath(client, { branch, path, since }) {
  const query = new URLSearchParams({
    sha: nonEmpty(branch, "branch"),
    path: nonEmpty(path, "path"),
    since: nonEmpty(since, "since"),
    per_page: "100",
  });
  const raw = await client.paginate(`/repos/${client.repository}/commits?${query}`);
  return raw.map((entry, i) => string(object(entry, `commit[${i}]`).sha, `commit[${i}].sha`));
}

export async function listPullRequestsForCommit(client, sha) {
  const raw = await client.paginate(
    `/repos/${client.repository}/commits/${encodeURIComponent(nonEmpty(sha, "sha"))}/pulls?per_page=100`,
  );
  return raw.map((entry, i) => {
    const pr = object(entry, `pull[${i}]`);
    return {
      number: integer(pr.number, `pull[${i}].number`),
      mergedAt: stringOrNull(pr.merged_at, `pull[${i}].merged_at`),
    };
  });
}

// ---------------------------------------------------------------------------
// Write endpoints.

export async function createIssue(client, { title, body, labels }) {
  const issue = object(
    await client.request("POST", `/repos/${client.repository}/issues`, { body: { title, body, labels } }),
    "created issue",
  );
  return { number: integer(issue.number, "created issue.number"), id: integer(issue.id, "created issue.id") };
}

export async function addLabels(client, number, labels) {
  issueNumber(number, "number");
  await client.request("POST", `/repos/${client.repository}/issues/${number}/labels`, { body: { labels } });
}

/**
 * Removes `label` from the issue. GitHub answers 404 when the label is not on the
 * issue — the state this call exists to reach — so a 404 counts as done: a re-run
 * after a crash that already removed the label must not fail on it. It is the only
 * non-2xx this module does not throw on; every other failure propagates.
 */
export async function removeLabel(client, number, label) {
  issueNumber(number, "number");
  const path = `/repos/${client.repository}/issues/${number}/labels/${encodeURIComponent(nonEmpty(label, "label"))}`;
  try {
    await client.request("DELETE", path);
  } catch (error) {
    if (error?.status !== 404) throw error;
  }
}

export async function closeIssue(client, number) {
  issueNumber(number, "number");
  await client.request("PATCH", `/repos/${client.repository}/issues/${number}`, {
    body: { state: "closed", state_reason: "completed" },
  });
}

export async function createComment(client, number, body) {
  issueNumber(number, "number");
  const comment = object(
    await client.request("POST", `/repos/${client.repository}/issues/${number}/comments`, { body: { body } }),
    "created comment",
  );
  return { id: integer(comment.id, "created comment.id") };
}

/** Links `childId` — the child issue's numeric `id`, not its number — as a sub-issue of `parentNumber`. */
export async function addSubIssue(client, parentNumber, childId) {
  issueNumber(parentNumber, "parentNumber");
  issueNumber(childId, "childId");
  await client.request("POST", `/repos/${client.repository}/issues/${parentNumber}/sub_issues`, {
    body: { sub_issue_id: childId },
  });
}
