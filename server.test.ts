// Tests for server.ts. The graph tests call buildGraph directly; the server
// tests start it on a free port with a made-up source and talk to it over real HTTP.
// Nothing here talks to Linear.
//
//   node --test server.test.ts

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import {
  buildGraph,
  createApp,
  linearSource,
  loadProjects,
  type Graph,
  type GraphNode,
  type LinearIssue,
  type ProjectEntry,
} from "./server.ts";

// --- Making issues -----------------------------------------------------------

type Extra = {
  state?: string; // triage, backlog, unstarted, started, completed, canceled
  blocks?: number[];
  related?: number[];
  milestone?: { id: string; name: string; sortOrder: number; targetDate?: string };
  assignee?: string;
  dueDate?: string;
  project?: string | null;
};

const NAMES: Record<string, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In Progress",
  completed: "Done",
  canceled: "Canceled",
};

/** Issue T-<number>. Its Linear id is "id-<number>", which is what relations point at. */
function issue(number: number, extra: Extra = {}): LinearIssue {
  const state = extra.state ?? "unstarted";
  return {
    id: `id-${number}`,
    identifier: `T-${number}`,
    title: `Issue ${number}`,
    url: `https://linear.app/test/issue/T-${number}`,
    priority: 0,
    dueDate: extra.dueDate ?? null,
    state: { name: NAMES[state], type: state, color: "#888888" },
    assignee: extra.assignee ? { name: extra.assignee } : null,
    project: extra.project === null ? null : { id: "p1", name: extra.project ?? "Test project" },
    projectMilestone: extra.milestone ? { targetDate: null, ...extra.milestone } : null,
    relations: {
      nodes: [
        ...(extra.blocks ?? []).map((other) => ({ type: "blocks", relatedIssue: { id: `id-${other}` } })),
        ...(extra.related ?? []).map((other) => ({ type: "related", relatedIssue: { id: `id-${other}` } })),
      ],
    },
  };
}

function node(graph: Graph, number: number): GraphNode {
  const found = graph.nodes.find((entry) => entry.id === `T-${number}`);
  assert.ok(found, `T-${number} is in the graph`);
  return found;
}

// --- The graph ---------------------------------------------------------------

test("each issue sits one rank past the last thing that blocks it", () => {
  // 1 -> 2 -> 4, and 3 -> 4
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2, { blocks: [4] }), issue(3, { blocks: [4] }), issue(4)]);
  assert.equal(node(graph, 1).rank, 0);
  assert.equal(node(graph, 2).rank, 1);
  assert.equal(node(graph, 4).rank, 2);
  assert.equal(graph.ranks, 3);
  assert.deepEqual(node(graph, 4).blockedBy, ["T-2", "T-3"]);
  assert.deepEqual(node(graph, 1).blocks, ["T-2"]);
});

test("an issue nothing blocks is placed next to what it blocks, not in the first rank", () => {
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2, { blocks: [4] }), issue(3, { blocks: [4] }), issue(4)]);
  assert.equal(node(graph, 3).rank, 1);
});

test("an issue with no relations at all stays in the first rank", () => {
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2), issue(3)]);
  assert.equal(node(graph, 3).rank, 0);
  assert.deepEqual(node(graph, 3).blocks, []);
});

test("a line that skips ranks gets a point in each rank it passes", () => {
  // 1 -> 2 -> 3 -> 4, and 1 -> 4 directly
  const graph = buildGraph([issue(1, { blocks: [2, 4] }), issue(2, { blocks: [3] }), issue(3, { blocks: [4] }), issue(4)]);
  const long = graph.edges.find((edge) => edge.from === "T-1" && edge.to === "T-4");
  assert.ok(long);
  assert.deepEqual(
    long.points.map(([rank]) => rank),
    [0, 1, 2, 3],
  );
  assert.deepEqual(long.points[0], [0, node(graph, 1).across]);
  assert.deepEqual(long.points[3], [3, node(graph, 4).across]);
  const short = graph.edges.find((edge) => edge.from === "T-1" && edge.to === "T-2");
  assert.equal(short?.points.length, 2);
});

test("nothing in a rank overlaps: cards are a full card apart, and passing lines keep clear of cards", () => {
  // A wide, tangled graph: every issue in one group blocks every issue in the next, with some long jumps.
  const issues = [
    issue(1, { blocks: [4, 5, 6, 9] }),
    issue(2, { blocks: [4, 6, 8] }),
    issue(3, { blocks: [5, 7, 9] }),
    issue(4, { blocks: [7, 8] }),
    issue(5, { blocks: [7, 9] }),
    issue(6, { blocks: [8] }),
    issue(7, { blocks: [9] }),
    issue(8, { blocks: [9] }),
    issue(9),
    issue(10),
    issue(11),
  ];
  const graph = buildGraph(issues);
  for (let rank = 0; rank < graph.ranks; rank++) {
    const cards = graph.nodes.filter((entry) => entry.rank === rank).map((entry) => entry.across);
    const lines = graph.edges.flatMap((edge) => edge.points.slice(1, -1).filter((point) => point[0] === rank).map((point) => point[1]));
    const sorted = [...cards].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index++) {
      assert.ok(sorted[index] - sorted[index - 1] >= 1, `cards in rank ${rank} are at least one card apart`);
    }
    for (const line of lines) {
      for (const card of cards) assert.ok(Math.abs(line - card) >= 0.55, `a line in rank ${rank} keeps clear of the cards`);
    }
  }
  assert.ok(Math.min(...graph.nodes.map((entry) => entry.across)) >= 0);
  assert.ok(graph.breadth >= Math.max(...graph.nodes.map((entry) => entry.across)) + 1);
});

test("ready, blocked and done follow the state of the blocking issues", () => {
  const graph = buildGraph([
    issue(1, { state: "completed", blocks: [2] }),
    issue(2, { blocks: [3] }),
    issue(3),
    issue(4, { state: "started" }),
    issue(5, { state: "started", blocks: [6] }),
    issue(6, { state: "started" }),
    issue(7, { state: "backlog" }),
  ]);
  assert.deepEqual(flags(node(graph, 1)), { done: true, blocked: false, ready: false });
  assert.deepEqual(flags(node(graph, 2)), { done: false, blocked: false, ready: true }); // its only blocker is done
  assert.deepEqual(flags(node(graph, 3)), { done: false, blocked: true, ready: false });
  assert.deepEqual(flags(node(graph, 4)), { done: false, blocked: false, ready: false }); // already under way
  assert.deepEqual(flags(node(graph, 6)), { done: false, blocked: true, ready: false }); // started, but still blocked
  assert.deepEqual(flags(node(graph, 7)), { done: false, blocked: false, ready: true });
});

function flags(entry: GraphNode): { done: boolean; blocked: boolean; ready: boolean } {
  return { done: entry.done, blocked: entry.blocked, ready: entry.ready };
}

test("cancelled issues, issues that were not read, and other kinds of relation are left out", () => {
  const graph = buildGraph([
    issue(1, { blocks: [2, 3, 99, 2], related: [4] }), // 99 was never read; 2 is listed twice
    issue(2),
    issue(3, { state: "canceled" }),
    issue(4),
  ]);
  assert.deepEqual(
    graph.nodes.map((entry) => entry.id),
    ["T-1", "T-2", "T-4"],
  );
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ["T-1>T-2"],
  );
  assert.equal(graph.totals.total, 3);
});

test("a loop of blocking relations is drawn, flagged and does not hang", () => {
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2, { blocks: [3] }), issue(3, { blocks: [1] })]);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 3);
  assert.equal(graph.edges.filter((edge) => edge.cyclic).length, 1);
  assert.match(graph.warnings.join(" "), /loop/);
  // In a loop every issue waits on another one.
  assert.ok(graph.nodes.every((entry) => entry.blocked));
});

test("identifiers sort by number, not as text", () => {
  const graph = buildGraph([issue(14, { blocks: [20] }), issue(9, { blocks: [20] }), issue(100, { blocks: [20] }), issue(20)]);
  assert.deepEqual(node(graph, 20).blockedBy, ["T-9", "T-14", "T-100"]);
  assert.deepEqual(
    graph.nodes.map((entry) => entry.id),
    ["T-9", "T-14", "T-20", "T-100"],
  );
});

test("progress is counted per milestone, in Linear's milestone order", () => {
  const later = { id: "m2", name: "Build", sortOrder: 20, targetDate: "2026-12-07" };
  const sooner = { id: "m1", name: "Plan", sortOrder: 10 };
  const graph = buildGraph([
    issue(1, { milestone: later, state: "completed" }),
    issue(2, { milestone: later, state: "started" }),
    issue(3, { milestone: later }),
    issue(4, { milestone: sooner, state: "completed" }),
    issue(5),
    issue(6, { milestone: later, state: "canceled" }),
  ]);
  assert.deepEqual(graph.milestones, [
    { id: "m1", name: "Plan", targetDate: null, total: 1, done: 1, started: 0 },
    { id: "m2", name: "Build", targetDate: "2026-12-07", total: 3, done: 1, started: 1 },
    { id: "none", name: "No milestone", targetDate: null, total: 1, done: 0, started: 0 },
  ]);
  assert.deepEqual(graph.totals, { total: 5, done: 2, started: 1 });
  assert.equal(node(graph, 5).milestone, "none");
  assert.equal(graph.title, "Test project");
});

test("an empty list gives an empty graph", () => {
  const graph = buildGraph([]);
  assert.deepEqual(graph.nodes, []);
  assert.equal(graph.ranks, 0);
  assert.equal(graph.breadth, 0);
  assert.equal(graph.title, "Linear issues");
});

test("a relation list that was cut short is reported", () => {
  const cut = issue(1, { blocks: [2] });
  cut.relations.pageInfo = { hasNextPage: true };
  assert.match(buildGraph([cut, issue(2)]).warnings.join(" "), /T-1 has more relations/);
});

test("every issue gets one status, and a collapsed status folds its issues into one dot", () => {
  const issues = [
    issue(1, { state: "completed", blocks: [3] }),
    issue(2, { state: "completed", blocks: [3] }),
    issue(3, { blocks: [4] }),
    issue(4, { state: "started" }),
    issue(5, { state: "started" }),
  ];
  const open = buildGraph(issues);
  assert.deepEqual(
    open.nodes.map((entry) => entry.status),
    ["done", "done", "ready", "blocked", "started"],
  );
  assert.ok(open.nodes.every((entry) => !entry.collapsed));
  assert.deepEqual(open.groups, []);

  const folded = buildGraph(issues, { collapse: ["done", "started"] });
  assert.deepEqual(
    folded.nodes.map((entry) => entry.collapsed),
    [true, true, false, false, true],
  );
  assert.deepEqual(
    folded.groups.map((group) => [group.id, group.status, group.members]),
    [
      ["group:started", "started", ["T-5"]],
      ["group:done", "done", ["T-1", "T-2"]],
    ],
  );
  // The two lines from the done issues into T-3 become one line from the dot.
  assert.deepEqual(
    folded.edges.map((edge) => `${edge.from}>${edge.to}`),
    ["T-3>T-4", "group:done>T-3"],
  );
  // A collapsed issue is placed where its dot is, and keeps its real relations for the side panel.
  const done = folded.groups.find((group) => group.id === "group:done")!;
  assert.deepEqual([node(folded, 1).rank, node(folded, 1).across], [done.rank, done.across]);
  assert.deepEqual(node(folded, 1).blocks, ["T-3"]);
  assert.deepEqual(node(folded, 3).blockedBy, ["T-1", "T-2"]);
  assert.equal(done.rank, node(folded, 3).rank - 1);
});

test("collapsing makes the graph smaller", () => {
  const issues = [
    issue(1, { state: "completed", blocks: [4] }),
    issue(2, { state: "completed", blocks: [4] }),
    issue(3, { state: "completed", blocks: [4] }),
    issue(4, { blocks: [5] }),
    issue(5),
  ];
  const open = buildGraph(issues);
  const folded = buildGraph(issues, { collapse: ["done"] });
  assert.equal(folded.ranks, open.ranks);
  assert.ok(folded.breadth < open.breadth, "three cards side by side became one dot");
  assert.equal(folded.nodes.filter((entry) => !entry.collapsed).length, 2);
});

test("two shown issues linked only through collapsed ones keep an indirect line", () => {
  // done T-1 -> ready T-2 -> blocked T-3, with the ready one collapsed
  const graph = buildGraph([issue(1, { state: "completed", blocks: [2] }), issue(2, { blocks: [3] }), issue(3)], { collapse: ["ready"] });
  const lines = graph.edges.map((edge) => `${edge.from}>${edge.to}${edge.via ? " (indirect)" : ""}`).sort();
  assert.deepEqual(lines, ["T-1>T-3 (indirect)", "T-1>group:ready", "group:ready>T-3"]);
  assert.deepEqual(graph.warnings, []);
});

test("a dot that sits both before and after the same card is not treated as a loop", () => {
  // done T-1 -> T-2 -> done T-3: with done collapsed, the dot both blocks T-2 and is blocked by it
  const graph = buildGraph([issue(1, { state: "completed", blocks: [2] }), issue(2, { blocks: [3] }), issue(3, { state: "completed" })], {
    collapse: ["done"],
  });
  assert.deepEqual(
    graph.edges.map((edge) => `${edge.from}>${edge.to}`),
    ["group:done>T-2"],
  );
  assert.ok(graph.edges.every((edge) => !edge.cyclic));
  assert.deepEqual(graph.warnings, []);
});

test("the flow runs down the page unless asked to run right, and only the spacing differs", () => {
  // T-1 -> T-2 -> T-3 with a direct T-1 -> T-3 that has to pass T-2
  const issues = [issue(1, { blocks: [2, 3] }), issue(2, { blocks: [3] }), issue(3)];
  const down = buildGraph(issues);
  const right = buildGraph(issues, { flow: "right" });
  assert.equal(down.flow, "down");
  assert.equal(right.flow, "right");
  assert.deepEqual(
    down.nodes.map((entry) => [entry.id, entry.rank]),
    right.nodes.map((entry) => [entry.id, entry.rank]),
  );
  const clearance = (graph: Graph): number => {
    const passing = graph.edges.find((edge) => edge.points.length === 3)!.points[1][1];
    return Math.abs(passing - node(graph, 2).across);
  };
  // A card is far wider than it is tall, so a passing line needs a smaller share of a card's width.
  assert.ok(clearance(down) < clearance(right));
  assert.ok(clearance(down) >= 0.55);
});

// --- Reading Linear ------------------------------------------------------------

type Call = { url: string; method: string; headers: Record<string, string>; body: { query: string; variables: Record<string, unknown> } };

/** A stand-in for fetch that answers from a list and records what it was sent. */
function fakeFetch(answers: { status?: number; body: unknown }[]): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    const answer = answers[calls.length - 1];
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const page = (nodes: LinearIssue[], endCursor: string | null) => ({
  body: { data: { issues: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } } },
});

test("linearSource sends the key as it is, the filter, and follows the pages", async () => {
  const { fetchImpl, calls } = fakeFetch([page([issue(1)], "cursor-1"), page([issue(2)], null)]);
  const read = linearSource({ apiKey: "lin_api_secret", team: "CS1", project: "Final", fetchImpl });
  const issues = await read();
  assert.deepEqual(
    issues.map((entry) => entry.identifier),
    ["T-1", "T-2"],
  );
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, "https://api.linear.app/graphql");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.authorization, "lin_api_secret");
    assert.deepEqual(call.body.variables.filter, { team: { key: { eq: "CS1" } }, project: { name: { eq: "Final" } } });
    assert.doesNotMatch(call.body.query, /mutation/);
  }
  assert.equal(calls[0].body.variables.after, null);
  assert.equal(calls[1].body.variables.after, "cursor-1");
});

test("linearSource with no team or project sends an empty filter", async () => {
  const { fetchImpl, calls } = fakeFetch([page([], null)]);
  await linearSource({ apiKey: "k", fetchImpl })();
  assert.deepEqual(calls[0].body.variables.filter, {});
});

test("a refused key and a Linear error become messages that do not contain the key", async () => {
  const refused = fakeFetch([{ status: 401, body: {} }]);
  await assert.rejects(linearSource({ apiKey: "lin_api_secret", fetchImpl: refused.fetchImpl })(), (error: Error) => {
    assert.match(error.message, /refused the API key/);
    assert.doesNotMatch(error.message, /lin_api_secret/);
    return true;
  });
  const failed = fakeFetch([{ body: { errors: [{ message: "Query too complex" }] } }]);
  await assert.rejects(linearSource({ apiKey: "lin_api_secret", fetchImpl: failed.fetchImpl })(), /Query too complex/);
  const down = fakeFetch([{ status: 503, body: {} }]);
  await assert.rejects(linearSource({ apiKey: "lin_api_secret", fetchImpl: down.fetchImpl })(), /HTTP 503/);
});

// --- The server ----------------------------------------------------------------

type App = {
  url: string;
  /** How many times the source has been read. */
  reads: () => number;
  /** Move the server's clock forward. */
  wait: (seconds: number) => void;
  close: () => Promise<void>;
};

async function start(source: (read: number) => LinearIssue[] | Error): Promise<App> {
  let reads = 0;
  let clock = 1_000_000;
  const server = createApp({
    source: async () => {
      const result = source(++reads);
      if (result instanceof Error) throw result;
      return result;
    },
    refreshSeconds: 120,
    minRefreshSeconds: 10,
    log: () => {},
    now: () => clock,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    reads: () => reads,
    wait: (seconds) => {
      clock += seconds * 1000;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

const chain = [issue(1, { blocks: [2] }), issue(2)];

test("the page and its script are served, with a policy that keeps the page to itself", async () => {
  const app = await start(() => chain);
  try {
    const page = await fetch(`${app.url}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(page.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.match(await page.text(), /<script type="module" src="\/app\.js">/);

    const script = await fetch(`${app.url}/app.js`);
    assert.equal(script.status, 200);
    assert.match(script.headers.get("content-type") ?? "", /javascript/);
  } finally {
    await app.close();
  }
});

test("nothing else on disk can be asked for, and the page cannot be written to", async () => {
  const app = await start(() => chain);
  try {
    for (const path of ["/server.ts", "/public/app.js", "/..%2Fserver.ts", "/%2e%2e/server.ts", "/app.js/x", "/api"]) {
      assert.equal((await fetch(`${app.url}${path}`)).status, 404, path);
    }
    assert.equal((await fetch(`${app.url}/`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${app.url}/api/graph`, { method: "DELETE" })).status, 405);
    assert.equal((await fetch(`${app.url}/api/refresh`)).status, 405);
  } finally {
    await app.close();
  }
});

test("/api/graph gives the graph and reads the source once while the copy is fresh", async () => {
  const app = await start(() => chain);
  try {
    const first = await fetch(`${app.url}/api/graph`);
    assert.equal(first.status, 200);
    const graph = await first.json();
    assert.deepEqual(
      graph.nodes.map((entry: GraphNode) => entry.id),
      ["T-1", "T-2"],
    );
    assert.equal(graph.syncError, null);
    assert.equal(graph.refreshSeconds, 120);
    assert.ok(!Number.isNaN(Date.parse(graph.lastSync)));

    app.wait(60);
    await fetch(`${app.url}/api/graph`);
    assert.equal(app.reads(), 1);
  } finally {
    await app.close();
  }
});

test("an old copy is answered at once and replaced behind the scenes", async () => {
  const app = await start((read) => (read === 1 ? chain : [...chain, issue(3)]));
  try {
    await fetch(`${app.url}/api/graph`);
    app.wait(121);
    const stale = await (await fetch(`${app.url}/api/graph`)).json();
    assert.equal(stale.nodes.length, 2); // still the old copy
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(app.reads(), 2);
    const fresh = await (await fetch(`${app.url}/api/graph`)).json();
    assert.equal(fresh.nodes.length, 3);
  } finally {
    await app.close();
  }
});

test("when the first read fails the answer is 503, and a later read recovers", async () => {
  const app = await start((read) => (read === 1 ? new Error("Linear refused the API key (HTTP 401)") : chain));
  try {
    const failed = await fetch(`${app.url}/api/graph`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: "Linear refused the API key (HTTP 401)" });

    // Asking again straight away does not hammer Linear.
    assert.equal((await fetch(`${app.url}/api/graph`)).status, 503);
    assert.equal(app.reads(), 1);

    app.wait(11);
    assert.equal((await fetch(`${app.url}/api/graph`)).status, 200);
    assert.equal(app.reads(), 2);
  } finally {
    await app.close();
  }
});

test("when a later read fails the last good graph is kept and the failure is reported", async () => {
  const app = await start((read) => (read === 2 ? new Error("Linear answered HTTP 503") : chain));
  try {
    const good = await (await fetch(`${app.url}/api/graph`)).json();
    app.wait(30);
    const response = await fetch(`${app.url}/api/refresh`, { method: "POST" });
    assert.equal(response.status, 200);
    const kept = await response.json();
    assert.equal(kept.nodes.length, 2);
    assert.equal(kept.syncError, "Linear answered HTTP 503");
    assert.equal(kept.lastSync, good.lastSync);

    app.wait(30);
    const recovered = await (await fetch(`${app.url}/api/refresh`, { method: "POST" })).json();
    assert.equal(recovered.syncError, null);
    assert.notEqual(recovered.lastSync, good.lastSync);
  } finally {
    await app.close();
  }
});

test("POST /api/refresh reads the source again, but not twice within a few seconds", async () => {
  const app = await start(() => chain);
  try {
    await fetch(`${app.url}/api/graph`);
    app.wait(11);
    const again = await (await fetch(`${app.url}/api/refresh`, { method: "POST" })).json();
    assert.equal(again.throttled, false);
    assert.equal(app.reads(), 2);

    app.wait(2);
    const tooSoon = await (await fetch(`${app.url}/api/refresh`, { method: "POST" })).json();
    assert.equal(tooSoon.throttled, true);
    assert.equal(tooSoon.nodes.length, 2);
    assert.equal(app.reads(), 2);
  } finally {
    await app.close();
  }
});

test("?collapse= and ?flow= choose how the graph is drawn, ignore anything else, and do not re-read Linear", async () => {
  const app = await start(() => [issue(1, { state: "completed", blocks: [2] }), issue(2)]);
  try {
    const plain = await (await fetch(`${app.url}/api/graph`)).json();
    assert.deepEqual(plain.collapsed, []);
    assert.equal(plain.flow, "down");
    assert.ok(plain.nodes.every((entry: GraphNode) => !entry.collapsed));

    const folded = await (await fetch(`${app.url}/api/graph?collapse=done,nonsense,__proto__&flow=right`)).json();
    assert.deepEqual(folded.collapsed, ["done"]);
    assert.equal(folded.flow, "right");
    assert.deepEqual(
      folded.nodes.map((entry: GraphNode) => [entry.id, entry.collapsed]),
      [
        ["T-1", true],
        ["T-2", false],
      ],
    );
    assert.deepEqual(
      folded.groups.map((group: { id: string }) => group.id),
      ["group:done"],
    );

    assert.equal((await (await fetch(`${app.url}/api/graph?flow=sideways`)).json()).flow, "down");

    const refreshed = await (await fetch(`${app.url}/api/refresh?collapse=ready`, { method: "POST" })).json();
    assert.deepEqual(refreshed.collapsed, ["ready"]);
    assert.equal(refreshed.throttled, true);
    assert.equal(app.reads(), 1);
  } finally {
    await app.close();
  }
});

test("/healthz says ok even when Linear cannot be read", async () => {
  const app = await start(() => new Error("down"));
  try {
    const health = await fetch(`${app.url}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(await health.text(), "ok\n");
    assert.equal(app.reads(), 0); // the health check never reads Linear
  } finally {
    await app.close();
  }
});

// --- Multi-project configuration & server -------------------------------------

test("loadProjects supports LINEAR_GRAPHS with separate API keys, filters, and fixtures", async () => {
  const requests: { auth: string | null; filter: unknown }[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    const body = JSON.parse(String(init?.body)) as { variables: { filter: unknown } };
    requests.push({ auth: headers.authorization ?? null, filter: body.variables.filter });
    return new Response(
      JSON.stringify({ data: { issues: { nodes: [issue(1)], pageInfo: { hasNextPage: false, endCursor: null } } } }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const projects = loadProjects(
    {
      LINEAR_API_KEY: "key-default",
      LINEAR_API_KEY_OTHER: "key-other",
      LINEAR_GRAPHS: JSON.stringify([
        { id: "alpha", name: "Alpha Board", team: "ALP", project: "Alpha Project" },
        { id: "beta", apiKeyEnv: "LINEAR_API_KEY_OTHER", team: "BET" },
        { id: "local", name: "Sample", fixture: "sample.json" },
      ]),
    },
    { fetchImpl },
  );

  assert.deepEqual(
    projects.map((p) => ({ id: p.id, name: p.name })),
    [
      { id: "alpha", name: "Alpha Board" },
      { id: "beta", name: "BET" },
      { id: "local", name: "Sample" },
    ],
  );

  await projects[0].source();
  await projects[1].source();
  assert.deepEqual(requests, [
    { auth: "key-default", filter: { team: { key: { eq: "ALP" } }, project: { name: { eq: "Alpha Project" } } } },
    { auth: "key-other", filter: { team: { key: { eq: "BET" } } } },
  ]);
});

test("loadProjects supports LINEAR_GRAPHS_FILE and legacy single-project env", () => {
  const fromFile = loadProjects(
    { LINEAR_GRAPHS_FILE: "/etc/graphs.json", LINEAR_API_KEY_WORK: "key-work" },
    { readConfigFile: () => JSON.stringify([{ id: "work", apiKeyEnv: "LINEAR_API_KEY_WORK", project: "Work" }]) },
  );
  assert.deepEqual(
    fromFile.map((p) => ({ id: p.id, name: p.name })),
    [{ id: "work", name: "Work" }],
  );

  const legacy = loadProjects({ LINEAR_API_KEY: "k", LINEAR_TEAM: "CS1", LINEAR_PROJECT: "Final" });
  assert.deepEqual(
    legacy.map((p) => ({ id: p.id, name: p.name })),
    [{ id: "default", name: "Final" }],
  );
});

test("loadProjects rejects invalid configs and disallowed apiKeyEnv names", () => {
  assert.throws(() => loadProjects({}), /LINEAR_API_KEY is not set/);
  assert.throws(
    () => loadProjects({ LINEAR_GRAPHS: "[]", LINEAR_GRAPHS_FILE: "/x.json" }),
    /not both/,
  );
  assert.throws(() => loadProjects({ LINEAR_GRAPHS: "not json" }), /could not parse/);
  assert.throws(() => loadProjects({ LINEAR_GRAPHS: "[]" }), /non-empty JSON array/);
  assert.throws(
    () => loadProjects({ LINEAR_API_KEY: "k", LINEAR_GRAPHS: JSON.stringify([{ id: "Bad Id" }]) }),
    /"id" must match/,
  );
  assert.throws(
    () => loadProjects({ LINEAR_API_KEY: "k", LINEAR_GRAPHS: JSON.stringify([{ id: "dup" }, { id: "dup" }]) }),
    /duplicate project id/,
  );
  assert.throws(
    () => loadProjects({ PATH: "/bin", LINEAR_GRAPHS: JSON.stringify([{ id: "a", apiKeyEnv: "PATH" }]) }),
    /"apiKeyEnv" must match/,
  );
  assert.throws(
    () => loadProjects({ LINEAR_GRAPHS: JSON.stringify([{ id: "a", apiKeyEnv: "LINEAR_API_KEY_MISSING" }]) }),
    /requires environment variable LINEAR_API_KEY_MISSING/,
  );
});

test("multi-project server lists projects, routes ?project=, and isolates caches and failures", async () => {
  let readsA = 0;
  let readsB = 0;
  let clock = 1_000_000;
  const projects: ProjectEntry[] = [
    {
      id: "alpha",
      name: "Alpha Project",
      source: async () => {
        readsA++;
        return [issue(1, { project: "Alpha Project" })];
      },
    },
    {
      id: "beta",
      name: "Beta Project",
      source: async () => {
        readsB++;
        if (readsB === 1) throw new Error("Linear refused the API key (HTTP 401)");
        return [issue(2, { project: "Beta Project" }), issue(3, { project: "Beta Project" })];
      },
    },
  ];
  const server = createApp({ projects, refreshSeconds: 120, minRefreshSeconds: 10, log: () => {}, now: () => clock });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const list = await fetch(`${url}/api/projects`);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), {
      projects: [
        { id: "alpha", name: "Alpha Project" },
        { id: "beta", name: "Beta Project" },
      ],
    });
    assert.equal((await fetch(`${url}/api/projects`, { method: "POST" })).status, 405);

    // Default graph is the first project.
    const def = await (await fetch(`${url}/api/graph`)).json();
    assert.deepEqual(def.project, { id: "alpha", name: "Alpha Project" });
    assert.deepEqual(
      def.nodes.map((n: GraphNode) => n.id),
      ["T-1"],
    );
    assert.equal(readsA, 1);
    assert.equal(readsB, 0);

    // Unknown project returns 404 on both /api/graph and /api/refresh.
    assert.equal((await fetch(`${url}/api/graph?project=nope`)).status, 404);
    assert.equal((await fetch(`${url}/api/refresh?project=nope`, { method: "POST" })).status, 404);

    // Failing second project returns 503 without breaking the first.
    const failedBeta = await fetch(`${url}/api/graph?project=beta`);
    assert.equal(failedBeta.status, 503);
    assert.equal((await fetch(`${url}/api/graph?project=alpha`)).status, 200);
    assert.equal(readsA, 1);
    assert.equal(readsB, 1);

    // After throttle window, refreshing beta recovers beta without touching alpha.
    clock += 11_000;
    const recoveredBeta = await (await fetch(`${url}/api/refresh?project=beta`, { method: "POST" })).json();
    assert.equal(recoveredBeta.throttled, false);
    assert.deepEqual(recoveredBeta.project, { id: "beta", name: "Beta Project" });
    assert.equal(recoveredBeta.nodes.length, 2);
    assert.equal(readsA, 1);
    assert.equal(readsB, 2);

    // Refreshing alpha right away is NOT blocked by beta's refresh.
    const refreshedAlpha = await (await fetch(`${url}/api/refresh?project=alpha`, { method: "POST" })).json();
    assert.equal(refreshedAlpha.throttled, false);
    assert.equal(readsA, 2);
  } finally {
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  }
});
