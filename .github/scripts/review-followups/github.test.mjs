import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addLabels,
  addSubIssue,
  clientFromEnv,
  closeIssue,
  createComment,
  createGitHubClient,
  createIssue,
  getCommitFiles,
  getIssue,
  listCommitsTouchingPath,
  listIssueComments,
  listIssuesWithLabel,
  listMergedPullRequests,
  listPullRequestCommits,
  listPullRequestsForCommit,
  listReviewThreads,
  listTreePaths,
  removeLabel,
} from "./github.mjs";

const API = "https://api.test";
const GRAPHQL = "https://api.test/graphql";
const TOKEN = "tok_secret_123";
const REPO = "owner/repo";

function reply(data, { status = 200, link } = {}) {
  const headers = link ? { link } : {};
  if (status === 204) return new Response(null, { status, headers });
  return new Response(typeof data === "string" ? data : JSON.stringify(data), { status, headers });
}

/** A fake `fetch` answering calls in order from `responses` (functions of the call, or plain responses). */
function fakeFetch(...responses) {
  const calls = [];
  const impl = async (url, init) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const next = responses[calls.length - 1];
    if (next === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    return typeof next === "function" ? next(call) : next;
  };
  impl.calls = calls;
  return impl;
}

function client(fetchImpl) {
  return createGitHubClient({ apiUrl: API, graphqlUrl: GRAPHQL, token: TOKEN, repository: REPO, fetchImpl });
}

const next = (url) => `<${url}>; rel="next", <${API}/last>; rel="last"`;

// --- request -----------------------------------------------------------------

test("request sends the four headers with a body and returns parsed JSON", async () => {
  const fetchImpl = fakeFetch(reply({ ok: 1 }));
  const result = await client(fetchImpl).request("POST", "/x", { body: { a: 1 } });
  assert.deepEqual(result, { ok: 1 });
  const [call] = fetchImpl.calls;
  assert.equal(call.url, `${API}/x`);
  assert.equal(call.method, "POST");
  assert.deepEqual(call.headers, {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${TOKEN}`,
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  });
  assert.deepEqual(call.body, { a: 1 });
});

test("request omits the content type without a body and returns null on 204", async () => {
  const fetchImpl = fakeFetch(reply(null, { status: 204 }));
  assert.equal(await client(fetchImpl).request("DELETE", "/y"), null);
  assert.equal(fetchImpl.calls[0].headers["content-type"], undefined);
  assert.equal(fetchImpl.calls[0].body, undefined);
});

for (const status of [403, 500]) {
  test(`request throws on ${status} with method, path and status`, async () => {
    const fetchImpl = fakeFetch(reply("nope", { status }));
    await assert.rejects(client(fetchImpl).request("GET", "/repos/owner/repo/issues"), (error) => {
      assert.match(error.message, /GET/);
      assert.match(error.message, /\/repos\/owner\/repo\/issues/);
      assert.match(error.message, new RegExp(String(status)));
      assert.equal(error.status, status);
      return true;
    });
  });
}

test("request never puts the token in the thrown message and caps the response text", async () => {
  const fetchImpl = fakeFetch(reply(`bad credentials ${TOKEN} ${"z".repeat(1000)}`, { status: 401 }));
  await assert.rejects(client(fetchImpl).request("GET", "/x"), (error) => {
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(error.message.length < 400);
    return true;
  });
});

// --- paginate ----------------------------------------------------------------

test("paginate follows two next links and returns all three pages in order", async () => {
  const fetchImpl = fakeFetch(
    reply([1, 2], { link: next(`${API}/items?page=2`) }),
    reply([3], { link: next(`${API}/items?page=3`) }),
    reply([4]),
  );
  assert.deepEqual(await client(fetchImpl).paginate("/items"), [1, 2, 3, 4]);
  assert.deepEqual(
    fetchImpl.calls.map((c) => c.url),
    [`${API}/items`, `${API}/items?page=2`, `${API}/items?page=3`],
  );
});

test("paginate throws when a page is an object instead of an array", async () => {
  await assert.rejects(client(fakeFetch(reply({ items: [] }))).paginate("/items"), /not a JSON array/);
});

test("paginate throws when the second page returns 502", async () => {
  const fetchImpl = fakeFetch(reply([1], { link: next(`${API}/items?page=2`) }), reply("bad gateway", { status: 502 }));
  await assert.rejects(client(fetchImpl).paginate("/items"), /502/);
});

test("paginate throws after 100 pages", async () => {
  const fetchImpl = async () => reply([1], { link: next(`${API}/items?page=n`) });
  await assert.rejects(client(fetchImpl).paginate("/items"), /more than 100 pages/);
});

test("paginate refuses a next link on another origin", async () => {
  const fetchImpl = fakeFetch(reply([1], { link: next("https://elsewhere.test/items?page=2") }));
  await assert.rejects(client(fetchImpl).paginate("/items"), /another origin/);
  assert.equal(fetchImpl.calls.length, 1);
});

// --- graphql -----------------------------------------------------------------

test("graphql posts the query and variables to graphqlUrl and returns data", async () => {
  const fetchImpl = fakeFetch(reply({ data: { viewer: { login: "me" } } }));
  assert.deepEqual(await client(fetchImpl).graphql("query { viewer { login } }", { a: 1 }), { viewer: { login: "me" } });
  assert.equal(fetchImpl.calls[0].url, GRAPHQL);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.deepEqual(fetchImpl.calls[0].body, { query: "query { viewer { login } }", variables: { a: 1 } });
});

test("graphql throws on an errors array, including its first message", async () => {
  const fetchImpl = fakeFetch(reply({ data: { x: 1 }, errors: [{ message: "x" }] }));
  await assert.rejects(client(fetchImpl).graphql("q", {}), /error\(s\): x/);
});

test("graphql throws when data is missing", async () => {
  await assert.rejects(client(fakeFetch(reply({}))).graphql("q", {}), /no data/);
});

test("graphql throws on a non-2xx response", async () => {
  await assert.rejects(client(fakeFetch(reply("down", { status: 500 }))).graphql("q", {}), /POST graphql failed \(500\)/);
});

// --- clientFromEnv -----------------------------------------------------------

/** Runs `body` with the global `fetch` replaced (clientFromEnv uses the default), returning the requested URLs. */
async function withStubbedFetch(body) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(url);
    return reply({ data: {} });
  };
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
  return seen;
}

test("clientFromEnv applies both defaults", async () => {
  const seen = await withStubbedFetch(async () => {
    const c = clientFromEnv({ GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: REPO });
    assert.equal(c.repository, REPO);
    await c.request("GET", "/rate_limit");
    await c.graphql("q", {});
  });
  assert.deepEqual(seen, ["https://api.github.com/rate_limit", "https://api.github.com/graphql"]);
});

test("clientFromEnv strips a trailing slash from GITHUB_API_URL and honours GITHUB_GRAPHQL_URL", async () => {
  const seen = await withStubbedFetch(async () => {
    const c = clientFromEnv({
      GITHUB_API_URL: "http://127.0.0.1:9999/",
      GITHUB_GRAPHQL_URL: "http://127.0.0.1:9999/gql",
      GITHUB_TOKEN: TOKEN,
      GITHUB_REPOSITORY: REPO,
    });
    await c.request("GET", "/x");
    await c.graphql("q", {});
  });
  assert.deepEqual(seen, ["http://127.0.0.1:9999/x", "http://127.0.0.1:9999/gql"]);
});

test("clientFromEnv throws naming a missing or malformed variable", () => {
  assert.throws(() => clientFromEnv({ GITHUB_REPOSITORY: REPO }), /GITHUB_TOKEN/);
  assert.throws(() => clientFromEnv({ GITHUB_TOKEN: TOKEN }), /GITHUB_REPOSITORY/);
  assert.throws(() => clientFromEnv({ GITHUB_TOKEN: TOKEN, GITHUB_REPOSITORY: "noslash" }), /GITHUB_REPOSITORY/);
});

// --- read endpoints ----------------------------------------------------------

const rawIssue = (number, extra = {}) => ({
  number,
  id: number * 1000,
  state: "open",
  title: `t${number}`,
  body: `b${number}`,
  labels: [{ name: "review-followup" }],
  ...extra,
});

test("listIssuesWithLabel drops pull requests, maps labels to names and a null body to empty", async () => {
  const fetchImpl = fakeFetch(
    reply([rawIssue(1, { body: null, labels: [{ name: "a" }, { name: "b" }] }), rawIssue(2, { pull_request: {} })], {
      link: next(`${API}/repos/owner/repo/issues?page=2`),
    }),
    reply([rawIssue(3)]),
  );
  const issues = await listIssuesWithLabel(client(fetchImpl), "review-followup", "open");
  assert.deepEqual(issues, [
    { number: 1, id: 1000, state: "open", title: "t1", body: "", labels: ["a", "b"] },
    { number: 3, id: 3000, state: "open", title: "t3", body: "b3", labels: ["review-followup"] },
  ]);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.pathname, "/repos/owner/repo/issues");
  assert.equal(url.searchParams.get("labels"), "review-followup");
  assert.equal(url.searchParams.get("state"), "open");
});

test("listIssuesWithLabel rejects a state other than open or all", async () => {
  await assert.rejects(listIssuesWithLabel(client(fakeFetch()), "x", "closed"), /state/);
});

test("listIssuesWithLabel throws on an entry of the wrong shape", async () => {
  const fetchImpl = fakeFetch(reply([rawIssue(1, { number: "1" })]));
  await assert.rejects(listIssuesWithLabel(client(fetchImpl), "x", "all"), /number is not an integer/);
});

test("getIssue returns one issue with label names and an empty body for null", async () => {
  const fetchImpl = fakeFetch(reply(rawIssue(7, { body: null, state: "closed" })));
  assert.deepEqual(await getIssue(client(fetchImpl), 7), {
    number: 7,
    id: 7000,
    state: "closed",
    title: "t7",
    body: "",
    labels: ["review-followup"],
  });
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/7`);
});

test("listIssueComments maps author from user.login across pages", async () => {
  const comment = (id, login) => ({ id, user: login === null ? null : { login }, created_at: `2026-09-2${id}T00:00:00Z`, body: `c${id}` });
  const fetchImpl = fakeFetch(
    reply([comment(1, "github-actions[bot]")], { link: next(`${API}/repos/owner/repo/issues/5/comments?page=2`) }),
    reply([comment(2, "alice"), comment(3, null)]),
  );
  assert.deepEqual(await listIssueComments(client(fetchImpl), 5), [
    { id: 1, author: "github-actions[bot]", createdAt: "2026-09-21T00:00:00Z", body: "c1" },
    { id: 2, author: "alice", createdAt: "2026-09-22T00:00:00Z", body: "c2" },
    { id: 3, author: "ghost", createdAt: "2026-09-23T00:00:00Z", body: "c3" },
  ]);
});

test("listMergedPullRequests drops unmerged pull requests and sorts ascending across pages", async () => {
  const pr = (number, merged_at) => ({ number, merged_at, labels: [{ name: "l" }] });
  const fetchImpl = fakeFetch(
    reply([pr(9, "2026-09-02T00:00:00Z"), pr(8, null)], { link: next(`${API}/repos/owner/repo/pulls?page=2`) }),
    reply([pr(3, "2026-09-01T00:00:00Z")]),
  );
  assert.deepEqual(await listMergedPullRequests(client(fetchImpl), "develop"), [
    { number: 3, mergedAt: "2026-09-01T00:00:00Z", labels: ["l"] },
    { number: 9, mergedAt: "2026-09-02T00:00:00Z", labels: ["l"] },
  ]);
  const url = new URL(fetchImpl.calls[0].url);
  assert.equal(url.searchParams.get("state"), "closed");
  assert.equal(url.searchParams.get("base"), "develop");
});

function threadsPage(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return reply({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes } } } } });
}

function thread(isResolved, comments, hasNextPage = false) {
  return { isResolved, comments: { pageInfo: { hasNextPage }, nodes: comments } };
}

test("listReviewThreads follows the cursor and returns authors in REST form", async () => {
  const fetchImpl = fakeFetch(
    threadsPage([thread(false, [{ databaseId: 11, body: "bot", author: { __typename: "Bot", login: "github-actions" } }])], {
      hasNextPage: true,
      endCursor: "CUR1",
    }),
    threadsPage([
      thread(true, [
        { databaseId: 21, body: "user", author: { __typename: "User", login: "alice" } },
        { databaseId: 22, body: "deleted", author: null },
      ]),
    ]),
  );
  assert.deepEqual(await listReviewThreads(client(fetchImpl), 42), [
    { isResolved: false, comments: [{ databaseId: 11, author: "github-actions[bot]", body: "bot" }] },
    {
      isResolved: true,
      comments: [
        { databaseId: 21, author: "alice", body: "user" },
        { databaseId: 22, author: "ghost", body: "deleted" },
      ],
    },
  ]);
  assert.deepEqual(fetchImpl.calls[0].body.variables, { owner: "owner", name: "repo", number: 42, cursor: null });
  assert.equal(fetchImpl.calls[1].body.variables.cursor, "CUR1");
});

test("listReviewThreads throws when a thread has more than 100 comments", async () => {
  const fetchImpl = fakeFetch(threadsPage([thread(false, [], true)]));
  await assert.rejects(listReviewThreads(client(fetchImpl), 42), /more than 100 comments/);
});

test("listReviewThreads throws when the pull request does not exist", async () => {
  const fetchImpl = fakeFetch(reply({ data: { repository: { pullRequest: null } } }));
  await assert.rejects(listReviewThreads(client(fetchImpl), 42), /pullRequest #42 is not an object/);
});

test("listTreePaths returns only blob paths", async () => {
  const fetchImpl = fakeFetch(
    reply({
      truncated: false,
      tree: [
        { path: "a", type: "tree" },
        { path: "a/b.md", type: "blob" },
        { path: "sub", type: "commit" },
      ],
    }),
  );
  assert.deepEqual(await listTreePaths(client(fetchImpl), "develop"), new Set(["a/b.md"]));
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/git/trees/develop?recursive=1`);
});

test("listTreePaths throws on a truncated tree", async () => {
  const fetchImpl = fakeFetch(reply({ truncated: true, tree: [{ path: "a", type: "blob" }] }));
  await assert.rejects(listTreePaths(client(fetchImpl), "develop"), /truncated/);
});

test("listPullRequestCommits returns SHAs in the listed order across pages", async () => {
  const fetchImpl = fakeFetch(
    reply([{ sha: "c" }, { sha: "a" }], { link: next(`${API}/repos/owner/repo/pulls/4/commits?page=2`) }),
    reply([{ sha: "b" }]),
  );
  assert.deepEqual(await listPullRequestCommits(client(fetchImpl), 4), ["c", "a", "b"]);
});

test("getCommitFiles includes a previous filename and reads a second page of files", async () => {
  const fetchImpl = fakeFetch(
    reply(
      { sha: "abc", files: [{ filename: "new.md", previous_filename: "old.md" }, { filename: "x.ts" }] },
      { link: next(`${API}/repos/owner/repo/commits/abc?page=2`) },
    ),
    reply({ sha: "abc", files: [{ filename: "y.ts" }] }),
  );
  assert.deepEqual(await getCommitFiles(client(fetchImpl), "abc"), ["new.md", "old.md", "x.ts", "y.ts"]);
  assert.equal(fetchImpl.calls[1].url, `${API}/repos/owner/repo/commits/abc?page=2`);
});

test("getCommitFiles throws when a page has no files array", async () => {
  await assert.rejects(getCommitFiles(client(fakeFetch(reply({ sha: "abc" }))), "abc"), /not a JSON array/);
});

test("listCommitsTouchingPath sends sha, encoded path and since, across pages", async () => {
  const fetchImpl = fakeFetch(
    reply([{ sha: "1" }], { link: next(`${API}/repos/owner/repo/commits?page=2`) }),
    reply([{ sha: "2" }]),
  );
  const shas = await listCommitsTouchingPath(client(fetchImpl), {
    branch: "develop",
    path: "review-rules/tasks/a b.md",
    since: "2026-09-01T00:00:00Z",
  });
  assert.deepEqual(shas, ["1", "2"]);
  const raw = fetchImpl.calls[0].url;
  assert.ok(raw.includes("path=review-rules%2Ftasks%2Fa+b.md"), raw);
  const url = new URL(raw);
  assert.equal(url.pathname, "/repos/owner/repo/commits");
  assert.equal(url.searchParams.get("sha"), "develop");
  assert.equal(url.searchParams.get("path"), "review-rules/tasks/a b.md");
  assert.equal(url.searchParams.get("since"), "2026-09-01T00:00:00Z");
});

test("listPullRequestsForCommit returns number and mergedAt for each pull request", async () => {
  const fetchImpl = fakeFetch(
    reply([
      { number: 5, merged_at: "2026-09-01T00:00:00Z" },
      { number: 6, merged_at: null },
    ]),
  );
  assert.deepEqual(await listPullRequestsForCommit(client(fetchImpl), "abc"), [
    { number: 5, mergedAt: "2026-09-01T00:00:00Z" },
    { number: 6, mergedAt: null },
  ]);
  assert.equal(new URL(fetchImpl.calls[0].url).pathname, "/repos/owner/repo/commits/abc/pulls");
});

// --- write endpoints ---------------------------------------------------------

test("createIssue sends title, body and labels and returns number and id", async () => {
  const fetchImpl = fakeFetch(reply({ number: 12, id: 9912, title: "t" }, { status: 201 }));
  assert.deepEqual(await createIssue(client(fetchImpl), { title: "t", body: "b", labels: ["x"] }), { number: 12, id: 9912 });
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues`);
  assert.deepEqual(fetchImpl.calls[0].body, { title: "t", body: "b", labels: ["x"] });
});

test("addLabels sends labels to the issue's labels endpoint", async () => {
  const fetchImpl = fakeFetch(reply([]));
  await addLabels(client(fetchImpl), 3, ["a", "b"]);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/3/labels`);
  assert.deepEqual(fetchImpl.calls[0].body, { labels: ["a", "b"] });
});

test("removeLabel resolves on 404", async () => {
  const fetchImpl = fakeFetch(reply({ message: "Label does not exist" }, { status: 404 }));
  await removeLabel(client(fetchImpl), 3, "agent:ready");
  assert.equal(fetchImpl.calls[0].method, "DELETE");
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/3/labels/agent%3Aready`);
});

test("removeLabel throws on 500", async () => {
  await assert.rejects(removeLabel(client(fakeFetch(reply("boom", { status: 500 }))), 3, "x"), /500/);
});

test("closeIssue sends state closed with state_reason completed", async () => {
  const fetchImpl = fakeFetch(reply(rawIssue(3)));
  await closeIssue(client(fetchImpl), 3);
  assert.equal(fetchImpl.calls[0].method, "PATCH");
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/3`);
  assert.deepEqual(fetchImpl.calls[0].body, { state: "closed", state_reason: "completed" });
});

test("createComment sends body to the comments endpoint and returns id", async () => {
  const fetchImpl = fakeFetch(reply({ id: 77, body: "hi" }, { status: 201 }));
  assert.deepEqual(await createComment(client(fetchImpl), 3, "hi"), { id: 77 });
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/3/comments`);
  assert.deepEqual(fetchImpl.calls[0].body, { body: "hi" });
});

test("addSubIssue sends sub_issue_id as a number", async () => {
  const fetchImpl = fakeFetch(reply(rawIssue(1), { status: 201 }));
  await addSubIssue(client(fetchImpl), 1, 123456);
  assert.equal(fetchImpl.calls[0].method, "POST");
  assert.equal(fetchImpl.calls[0].url, `${API}/repos/owner/repo/issues/1/sub_issues`);
  assert.deepEqual(fetchImpl.calls[0].body, { sub_issue_id: 123456 });
  assert.equal(typeof fetchImpl.calls[0].body.sub_issue_id, "number");
});

test("addSubIssue rejects a child id that is not a positive integer without a request", async () => {
  const fetchImpl = fakeFetch();
  await assert.rejects(addSubIssue(client(fetchImpl), 1, "123"), /childId/);
  assert.equal(fetchImpl.calls.length, 0);
});
