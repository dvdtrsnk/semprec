import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LABELS,
  PUBLISHER_LOGIN,
  computeLedger,
  findingId,
  parseEpicMarker,
  parseFindingMarkers,
  parseHarvestMarker,
  parseResultMarker,
  renderEpicMarker,
  renderFindingMarker,
  renderHarvestMarker,
  renderResultMarker,
} from "./markers.mjs";

const KEY = "0123456789";
const KEY_B = "abcdef0123";

describe("constants", () => {
  it("exposes frozen pipeline labels and the publisher login", () => {
    assert.deepEqual(LABELS, {
      harvested: "followups:harvested",
      harvest: "followups:harvest",
      ready: "followups:ready",
      issue: "followups:issue",
      proposed: "spec:proposed",
    });
    assert.ok(Object.isFrozen(LABELS));
    assert.equal(PUBLISHER_LOGIN, "bb-agent-relay[bot]");
  });

  it("builds a finding id from pr and key", () => {
    assert.equal(findingId({ pr: 12, key: KEY }), `12:${KEY}`);
  });
});

describe("round trips", () => {
  it("parses a rendered finding marker back to its values", () => {
    const text = `${renderFindingMarker({ pr: 300, key: KEY })}\n${renderFindingMarker({ pr: 7, key: KEY_B })}`;
    assert.deepEqual(parseFindingMarkers(text), [
      { pr: 300, key: KEY },
      { pr: 7, key: KEY_B },
    ]);
  });

  it("parses a rendered harvest marker back to its values", () => {
    assert.deepEqual(parseHarvestMarker(renderHarvestMarker([266, 270, 301])), [266, 270, 301]);
    assert.deepEqual(parseHarvestMarker(renderHarvestMarker([5])), [5]);
  });

  it("parses rendered epic and result markers back to their values", () => {
    assert.equal(parseEpicMarker(renderEpicMarker(42)), 42);
    assert.equal(parseResultMarker(renderResultMarker(43)), 43);
  });

  it("returns empty or null when no marker is present", () => {
    assert.deepEqual(parseFindingMarkers("nothing here"), []);
    assert.equal(parseHarvestMarker("nothing here"), null);
    assert.equal(parseEpicMarker(""), null);
    assert.equal(parseResultMarker(""), null);
  });
});

describe("render validation", () => {
  it("rejects an invalid pr in renderFindingMarker", () => {
    for (const pr of [0, -1, 1.5, "07", "7", NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => renderFindingMarker({ pr, key: KEY }), TypeError, String(pr));
    }
  });

  it("rejects an invalid key in renderFindingMarker", () => {
    for (const key of ["012345678", "01234567890", "ABCDEF0123", "ghijklmnop", 1234567890]) {
      assert.throws(() => renderFindingMarker({ pr: 1, key }), TypeError, String(key));
    }
  });

  it("rejects an empty, unsorted, duplicate or invalid list in renderHarvestMarker", () => {
    for (const prs of [[], [3, 2], [2, 2], [0], [1, "2"], "1,2"]) {
      assert.throws(() => renderHarvestMarker(prs), TypeError, JSON.stringify(prs));
    }
  });

  it("rejects an invalid harvest number in renderEpicMarker and renderResultMarker", () => {
    for (const harvest of [0, -3, 2.5, "9"]) {
      assert.throws(() => renderEpicMarker(harvest), TypeError);
      assert.throws(() => renderResultMarker(harvest), TypeError);
    }
  });
});

describe("line matching", () => {
  const finding = renderFindingMarker({ pr: 9, key: KEY });
  const harvest = renderHarvestMarker([9]);
  const epic = renderEpicMarker(9);
  const result = renderResultMarker(9);

  it("ignores markers embedded in a longer line", () => {
    for (const marker of [finding, harvest, epic, result]) {
      for (const line of [
        `| ${marker} | cell |`,
        JSON.stringify({ body: marker }),
        `before ${marker}`,
        `${marker} after`,
        ` ${marker}`,
      ]) {
        const text = `intro\n${line}\noutro`;
        assert.deepEqual(parseFindingMarkers(text), [], line);
        assert.equal(parseHarvestMarker(text), null, line);
        assert.equal(parseEpicMarker(text), null, line);
        assert.equal(parseResultMarker(text), null, line);
      }
    }
  });

  it("accepts a marker alone on its line with trailing spaces or \\r", () => {
    for (const suffix of ["  ", "\r", " \t\r"]) {
      assert.deepEqual(parseFindingMarkers(`a\n${finding}${suffix}\nb`), [{ pr: 9, key: KEY }]);
      assert.deepEqual(parseHarvestMarker(`a\r\n${harvest}${suffix}\nb`), [9]);
      assert.equal(parseEpicMarker(`${epic}${suffix}`), 9);
      assert.equal(parseResultMarker(`${result}${suffix}`), 9);
    }
  });

  it("ignores malformed marker lines", () => {
    const malformedFindings = [
      `<!-- crb-followup:v2 pr=9 key=${KEY} -->`,
      `<!-- crb-followup:v1 key=${KEY} -->`,
      "<!-- crb-followup:v1 pr=9 -->",
      "<!-- crb-followup:v1 pr=9 key=ABCDEF0123 -->",
      "<!-- crb-followup:v1 pr=9 key=012345678 -->",
      "<!-- crb-followup:v1 pr=9 key=01234567890 -->",
      `<!-- crb-followup:v1 pr=09 key=${KEY} -->`,
      `<!-- crb-followup:v1 pr=0 key=${KEY} -->`,
      `<!-- crb-followup:v1 pr=99999999999999999999 key=${KEY} -->`,
    ];
    assert.deepEqual(parseFindingMarkers(malformedFindings.join("\n")), []);

    const malformedHarvests = [
      "<!-- crb-followup-harvest:v2 prs=1,2 -->",
      "<!-- crb-followup-harvest:v1 prs= -->",
      "<!-- crb-followup-harvest:v1 -->",
      "<!-- crb-followup-harvest:v1 prs=2,1 -->",
      "<!-- crb-followup-harvest:v1 prs=1,1 -->",
      "<!-- crb-followup-harvest:v1 prs=01,2 -->",
      "<!-- crb-followup-harvest:v1 prs=1,,2 -->",
    ];
    assert.equal(parseHarvestMarker(malformedHarvests.join("\n")), null);

    for (const name of ["epic", "result"]) {
      const parse = name === "epic" ? parseEpicMarker : parseResultMarker;
      const lines = [
        `<!-- crb-followup-${name}:v2 harvest=9 -->`,
        `<!-- crb-followup-${name}:v1 -->`,
        `<!-- crb-followup-${name}:v1 harvest= -->`,
        `<!-- crb-followup-${name}:v1 harvest=09 -->`,
      ];
      assert.equal(parse(lines.join("\n")), null, name);
    }
  });

  it("skips a malformed marker and still finds a valid one after it", () => {
    const text = `<!-- crb-followup-epic:v1 harvest=09 -->\n${epic}`;
    assert.equal(parseEpicMarker(text), 9);
  });

  it("rejects non-string text", () => {
    assert.throws(() => parseFindingMarkers(undefined), TypeError);
  });
});

function issue(number, labels, body, comments = []) {
  return { number, labels, body, comments };
}

const findingA = { pr: 300, key: KEY };
const findingB = { pr: 301, key: KEY_B };
const idA = findingId(findingA);
const idB = findingId(findingB);

function resultComment(author, findings, withResult = true) {
  const lines = findings.map(renderFindingMarker);
  if (withResult) lines.unshift(renderResultMarker(1));
  return { author, body: lines.join("\n") };
}

describe("computeLedger", () => {
  it("returns empty collections for no issues", () => {
    const ledger = computeLedger([]);
    assert.equal(ledger.harvested.size, 0);
    assert.equal(ledger.terminal.size, 0);
    assert.equal(ledger.harvestedPrs.size, 0);
    assert.equal(ledger.epics.size, 0);
  });

  it("puts a harvest-body finding in harvested but not terminal", () => {
    const ledger = computeLedger([issue(1, [LABELS.harvest], renderFindingMarker(findingA))]);
    assert.deepEqual([...ledger.harvested], [idA]);
    assert.deepEqual([...ledger.terminal], []);
  });

  it("puts a follow-up-issue-body finding in harvested and terminal", () => {
    const ledger = computeLedger([issue(2, [LABELS.issue], renderFindingMarker(findingA))]);
    assert.deepEqual([...ledger.harvested], [idA]);
    assert.deepEqual([...ledger.terminal], [idA]);
  });

  it("puts findings of a publisher result comment on a harvest issue in both sets", () => {
    const ledger = computeLedger([
      issue(1, [LABELS.harvest], "", [resultComment(PUBLISHER_LOGIN, [findingA, findingB])]),
    ]);
    assert.deepEqual([...ledger.harvested].sort(), [idA, idB].sort());
    assert.deepEqual([...ledger.terminal].sort(), [idA, idB].sort());
  });

  it("ignores result comments by another author and comments without a result marker", () => {
    const ledger = computeLedger([
      issue(1, [LABELS.harvest], "", [
        resultComment("someone", [findingA]),
        resultComment(PUBLISHER_LOGIN, [findingB], false),
      ]),
    ]);
    assert.equal(ledger.harvested.size, 0);
    assert.equal(ledger.terminal.size, 0);
  });

  it("ignores comments on a follow-up issue", () => {
    const ledger = computeLedger([issue(2, [LABELS.issue], "", [resultComment(PUBLISHER_LOGIN, [findingA])])]);
    assert.equal(ledger.harvested.size, 0);
    assert.equal(ledger.terminal.size, 0);
  });

  it("ignores every marker on an issue with neither pipeline label", () => {
    const body = [
      renderFindingMarker(findingA),
      renderHarvestMarker([300]),
      renderEpicMarker(1),
      renderResultMarker(1),
    ].join("\n");
    const ledger = computeLedger([
      issue(3, [LABELS.ready, LABELS.proposed, "bug"], body, [resultComment(PUBLISHER_LOGIN, [findingB])]),
    ]);
    assert.equal(ledger.harvested.size, 0);
    assert.equal(ledger.terminal.size, 0);
    assert.equal(ledger.harvestedPrs.size, 0);
    assert.equal(ledger.epics.size, 0);
  });

  it("collects pull requests of every harvest marker in harvest bodies only", () => {
    const ledger = computeLedger([
      issue(1, [LABELS.harvest], `${renderHarvestMarker([266, 270])}\n${renderHarvestMarker([280])}`),
      issue(4, [LABELS.harvest], renderHarvestMarker([270, 290])),
      issue(5, [LABELS.issue], renderHarvestMarker([999])),
    ]);
    assert.deepEqual(
      [...ledger.harvestedPrs].sort((a, b) => a - b),
      [266, 270, 280, 290],
    );
  });

  it("maps a harvest to the lower of two epic numbers, whatever the input order", () => {
    for (const order of [
      [20, 10],
      [10, 20],
    ]) {
      const ledger = computeLedger([
        ...order.map((n) => issue(n, [LABELS.issue], renderEpicMarker(1))),
        issue(30, [LABELS.issue], renderEpicMarker(2)),
        issue(40, [LABELS.harvest], renderEpicMarker(3)),
      ]);
      assert.deepEqual([...ledger.epics.entries()].sort(), [
        [1, 10],
        [2, 30],
      ]);
    }
  });

  it("treats closed and open issues identically", () => {
    const build = (state) => [
      {
        ...issue(1, [LABELS.harvest], `${renderHarvestMarker([300])}\n${renderFindingMarker(findingA)}`, [
          resultComment(PUBLISHER_LOGIN, [findingB]),
        ]),
        state,
      },
      { ...issue(2, [LABELS.issue], `${renderEpicMarker(1)}\n${renderFindingMarker(findingB)}`), state },
    ];
    const open = computeLedger(build("open"));
    const closed = computeLedger(build("closed"));
    assert.deepEqual(closed, open);
    assert.deepEqual([...open.harvested].sort(), [idA, idB].sort());
    assert.deepEqual([...open.terminal], [idB]);
    assert.deepEqual([...open.harvestedPrs], [300]);
    assert.deepEqual([...open.epics], [[1, 2]]);
  });

  it("throws on input that does not have the documented shape", () => {
    for (const input of [
      null,
      [null],
      [{ number: 0, labels: [], body: "", comments: [] }],
      [{ number: 1, labels: "x", body: "", comments: [] }],
      [{ number: 1, labels: [1], body: "", comments: [] }],
      [{ number: 1, labels: [], body: null, comments: [] }],
      [{ number: 1, labels: [], body: "" }],
      [{ number: 1, labels: [], body: "", comments: [{ author: "a" }] }],
      [{ number: 1, labels: [], body: "", comments: [null] }],
    ]) {
      assert.throws(() => computeLedger(input), TypeError, JSON.stringify(input));
    }
  });
});
