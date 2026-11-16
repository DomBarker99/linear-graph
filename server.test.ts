// Tests for server.ts. The graph tests call buildGraph directly; the server
// tests start it on a free port with a made-up source and talk to it over real HTTP.
// Nothing here talks to Linear.
//
//   node --test server.test.ts

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { buildGraph, createApp, linearSource, type Graph, type GraphNode, type LinearIssue } from "./server.ts";

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

test("each issue sits one column right of the last thing that blocks it", () => {
  // 1 -> 2 -> 4, and 3 -> 4
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2, { blocks: [4] }), issue(3, { blocks: [4] }), issue(4)]);
  assert.equal(node(graph, 1).col, 0);
  assert.equal(node(graph, 2).col, 1);
  assert.equal(node(graph, 4).col, 2);
  assert.equal(graph.columns, 3);
  assert.deepEqual(node(graph, 4).blockedBy, ["T-2", "T-3"]);
  assert.deepEqual(node(graph, 1).blocks, ["T-2"]);
});

test("an issue nothing blocks is placed next to what it blocks, not in the first column", () => {
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2, { blocks: [4] }), issue(3, { blocks: [4] }), issue(4)]);
  assert.equal(node(graph, 3).col, 1);
});

test("an issue with no relations at all stays in the first column", () => {
  const graph = buildGraph([issue(1, { blocks: [2] }), issue(2), issue(3)]);
  assert.equal(node(graph, 3).col, 0);
  assert.deepEqual(node(graph, 3).blocks, []);
});

test("a line that skips columns gets a point in each column it passes", () => {
  // 1 -> 2 -> 3 -> 4, and 1 -> 4 directly
  const graph = buildGraph([issue(1, { blocks: [2, 4] }), issue(2, { blocks: [3] }), issue(3, { blocks: [4] }), issue(4)]);
  const long = graph.edges.find((edge) => edge.from === "T-1" && edge.to === "T-4");
  assert.ok(long);
  assert.deepEqual(
    long.points.map(([col]) => col),
    [0, 1, 2, 3],
  );
  assert.deepEqual(long.points[0], [0, node(graph, 1).y]);
  assert.deepEqual(long.points[3], [3, node(graph, 4).y]);
  const short = graph.edges.find((edge) => edge.from === "T-1" && edge.to === "T-2");
  assert.equal(short?.points.length, 2);
});

test("nothing in a column overlaps: cards are a full card apart, and passing lines keep clear of cards", () => {
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
  for (let col = 0; col < graph.columns; col++) {
    const cards = graph.nodes.filter((entry) => entry.col === col).map((entry) => entry.y);
    const lines = graph.edges.flatMap((edge) => edge.points.slice(1, -1).filter((point) => point[0] === col).map((point) => point[1]));
    const sorted = [...cards].sort((a, b) => a - b);
    for (let index = 1; index < sorted.length; index++) {
      assert.ok(sorted[index] - sorted[index - 1] >= 1, `cards in column ${col} are at least one card apart`);
    }
    for (const line of lines) {
      for (const card of cards) assert.ok(Math.abs(line - card) >= 0.6, `a line in column ${col} keeps clear of the cards`);
    }
  }
  assert.ok(Math.min(...graph.nodes.map((entry) => entry.y)) >= 0);
  assert.ok(graph.height >= Math.max(...graph.nodes.map((entry) => entry.y)) + 1);
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
  assert.equal(graph.columns, 0);
  assert.equal(graph.height, 0);
  assert.equal(graph.title, "Linear issues");
});

test("a relation list that was cut short is reported", () => {
  const cut = issue(1, { blocks: [2] });
  cut.relations.pageInfo = { hasNextPage: true };
  assert.match(buildGraph([cut, issue(2)]).warnings.join(" "), /T-1 has more relations/);
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
