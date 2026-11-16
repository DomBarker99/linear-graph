// linear-graph: a read-only dependency graph of Linear issues.
//
// Linear shows "blocked by" and "blocks" on each issue but has no picture of the
// whole chain. This server reads the issues with a read-only Linear API key,
// works out the graph (columns, rows, which issues are ready to start) and
// serves one page that draws it.
//
//   GET  /              the page (public/index.html, public/app.js)
//   GET  /api/graph     the graph as JSON; re-reads Linear when the copy is old
//                       ?collapse=done,blocked draws those issues as dots instead of cards
//   POST /api/refresh   re-read Linear now (at most once every few seconds)
//   GET  /healthz       "ok"
//
// Nothing here writes to Linear: the only request it ever sends is one query.
// There is no login. Whoever can reach the port can read the issues.
//
// Settings (environment):
//   LINEAR_API_KEY    a Linear personal API key with Read permission only
//   LINEAR_TEAM       optional team key, e.g. CS1: only that team's issues
//   LINEAR_PROJECT    optional project name: only that project's issues
//   REFRESH_SECONDS   how old the copy may get before Linear is read again (default 120)
//   PORT              default 8080
//   HOST              address to listen on (default 0.0.0.0; use 127.0.0.1 to keep it to this machine)
//   GRAPH_FIXTURE     path to a JSON file of issues, read instead of Linear (for trying it locally)
//
// Run:   LINEAR_API_KEY=... LINEAR_TEAM=CS1 node server.ts
// Try:   GRAPH_FIXTURE=sample.json HOST=127.0.0.1 node server.ts
// Test:  node --test server.test.ts
//
// Node runs this file directly (type stripping): no build step, no dependencies.

import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// What Linear sends
// ---------------------------------------------------------------------------

/** One issue, in the shape of the query below. */
export type LinearIssue = {
  /** Linear's internal id. Relations point at this, not at the identifier. */
  id: string;
  /** What people see, e.g. "CS1-14". */
  identifier: string;
  title: string;
  url: string;
  /** 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: number;
  /** "2026-12-07" or null. */
  dueDate: string | null;
  /** type is one of triage, backlog, unstarted, started, completed, canceled. */
  state: { name: string; type: string; color: string };
  assignee: { name: string } | null;
  project: { id: string; name: string } | null;
  projectMilestone: { id: string; name: string; targetDate: string | null; sortOrder: number } | null;
  /** type "blocks" means this issue blocks relatedIssue. */
  relations: { nodes: { type: string; relatedIssue: { id: string } }[]; pageInfo?: { hasNextPage: boolean } };
};

// Fixed on purpose. If this could be set from outside, whoever set it would be
// sent the API key in the next request.
const LINEAR_URL = "https://api.linear.app/graphql";
const ISSUES_PER_PAGE = 40;
const RELATIONS_PER_ISSUE = 30;
const MAX_PAGES = 25;

export const ISSUES_QUERY = `
query LinearGraph($after: String, $filter: IssueFilter) {
  issues(first: ${ISSUES_PER_PAGE}, after: $after, filter: $filter) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      identifier
      title
      url
      priority
      dueDate
      state { name type color }
      assignee { name }
      project { id name }
      projectMilestone { id name targetDate sortOrder }
      relations(first: ${RELATIONS_PER_ISSUE}) {
        pageInfo { hasNextPage }
        nodes { type relatedIssue { id } }
      }
    }
  }
}`;

export type LinearOptions = {
  apiKey: string;
  team?: string;
  project?: string;
  /** Replaced in tests. */
  fetchImpl?: typeof fetch;
};

/** Reads every matching issue from Linear, page by page. */
export function linearSource(options: LinearOptions): () => Promise<LinearIssue[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const filter: Record<string, unknown> = {};
  if (options.team) filter.team = { key: { eq: options.team } };
  if (options.project) filter.project = { name: { eq: options.project } };

  return async () => {
    const issues: LinearIssue[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const response = await fetchImpl(LINEAR_URL, {
        method: "POST",
        // A personal API key goes in as it is, without "Bearer".
        headers: { "content-type": "application/json", authorization: options.apiKey },
        body: JSON.stringify({ query: ISSUES_QUERY, variables: { after, filter } }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Linear refused the API key (HTTP ${response.status})`);
      }
      if (response.status === 429) throw new Error("Linear says too many requests; it will be tried again later");
      if (!response.ok) throw new Error(`Linear answered HTTP ${response.status}`);
      const body = (await response.json()) as {
        data?: { issues?: { nodes: LinearIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
        errors?: { message?: string }[];
      };
      if (body.errors?.length) {
        throw new Error(`Linear returned an error: ${String(body.errors[0].message ?? "unknown").slice(0, 200)}`);
      }
      const connection = body.data?.issues;
      if (!connection) throw new Error("Linear's answer had no issues in it");
      issues.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return issues;
      after = connection.pageInfo.endCursor;
    }
    throw new Error(`more than ${MAX_PAGES * ISSUES_PER_PAGE} issues; narrow it with LINEAR_TEAM or LINEAR_PROJECT`);
  };
}

/** Reads issues from a JSON file instead of Linear. For trying the page locally. */
export function fixtureSource(path: string): () => Promise<LinearIssue[]> {
  return async () => JSON.parse(await readFile(path, "utf8")) as LinearIssue[];
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

export type GraphNode = {
  /** The identifier, e.g. "CS1-14". */
  id: string;
  title: string;
  url: string;
  state: { name: string; type: string };
  assignee: string | null;
  dueDate: string | null;
  priority: number;
  /** Milestone id, or "none". */
  milestone: string;
  /** Column, counted from 0 on the left. */
  col: number;
  /** Vertical position in card heights, 0 at the top. */
  y: number;
  done: boolean;
  /** Not done, and at least one issue that blocks it is not done. */
  blocked: boolean;
  /** Not started, and nothing open blocks it. */
  ready: boolean;
  /** The one word the page colours by: done, blocked, started or ready. */
  status: Status;
  /** Drawn as a dot instead of a card, because its status was asked to be collapsed. */
  collapsed: boolean;
  blockedBy: string[];
  blocks: string[];
};

/** Every issue has exactly one of these. Blocked wins over started: work under way that is still waiting counts as blocked. */
export const STATUSES = ["ready", "started", "blocked", "done"] as const;
export type Status = (typeof STATUSES)[number];

export type GraphEdge = {
  /** The blocking issue. */
  from: string;
  /** The issue it blocks. */
  to: string;
  /** Part of a loop (A blocks B blocks A). Drawn differently and left out of the layout. */
  cyclic: boolean;
  /** [col, y] from source to target. Long edges get one point per column they pass. */
  points: [number, number][];
};

export type Milestone = {
  id: string;
  name: string;
  targetDate: string | null;
  total: number;
  done: number;
  started: number;
};

export type Graph = {
  title: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  milestones: Milestone[];
  totals: { total: number; done: number; started: number };
  columns: number;
  /** Height of the tallest column, in card heights. */
  height: number;
  warnings: string[];
};

const NO_MILESTONE = "none";

// Vertical room each thing takes, in card heights. A long edge passing through
// a column takes a thin slot, so cards are never drawn on top of a line.
// An issue collapsed to a dot takes the same thin slot as a line.
const CARD_SLOT = 1;
const LINE_SLOT = 0.3;
const DOT_SLOT = 0.3;
const SLOT_GAP = 0.08;

/** "CS1-9" sorts before "CS1-14". */
function compareIdentifiers(a: string, b: string): number {
  const [teamA, numberA] = splitIdentifier(a);
  const [teamB, numberB] = splitIdentifier(b);
  return teamA === teamB ? numberA - numberB : teamA < teamB ? -1 : 1;
}

function splitIdentifier(identifier: string): [string, number] {
  const dash = identifier.lastIndexOf("-");
  return [identifier.slice(0, dash), Number(identifier.slice(dash + 1)) || 0];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Closest non-decreasing sequence to the given one (least squares). Used to
 * move the things in a column toward where they want to be without letting
 * them swap places or overlap.
 */
function nonDecreasingFit(values: number[]): number[] {
  const blocks: { sum: number; count: number }[] = [];
  for (const value of values) {
    blocks.push({ sum: value, count: 1 });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const previous = blocks[blocks.length - 2];
      if (previous.sum / previous.count <= last.sum / last.count) break;
      previous.sum += last.sum;
      previous.count += last.count;
      blocks.pop();
    }
  }
  return blocks.flatMap((block) => Array<number>(block.count).fill(block.sum / block.count));
}

/** Turn Linear's issues into nodes with positions, edges, and progress counts. */
export function buildGraph(issues: LinearIssue[], options: { collapse?: Iterable<Status> } = {}): Graph {
  const collapse = new Set(options.collapse ?? []);
  const warnings: string[] = [];
  // Cancelled and duplicate issues are left out: they are neither work to do nor work done.
  const kept = issues
    .filter((issue) => issue.state.type !== "canceled")
    .sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
  const byLinearId = new Map(kept.map((issue) => [issue.id, issue]));
  const issueOf = new Map(kept.map((issue) => [issue.identifier, issue]));
  const ids = kept.map((issue) => issue.identifier);

  // --- Edges: "A blocks B" becomes A -> B -------------------------------
  const blocks = new Map<string, string[]>(ids.map((id) => [id, []]));
  const blockedBy = new Map<string, string[]>(ids.map((id) => [id, []]));
  const edgeKeys = new Set<string>();
  for (const issue of kept) {
    if (issue.relations?.pageInfo?.hasNextPage) {
      warnings.push(`${issue.identifier} has more relations than were read; some of its lines may be missing`);
    }
    for (const relation of issue.relations?.nodes ?? []) {
      if (relation.type !== "blocks") continue;
      const target = byLinearId.get(relation.relatedIssue.id);
      if (!target || target.id === issue.id) continue;
      const key = `${issue.identifier}>${target.identifier}`;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      blocks.get(issue.identifier)!.push(target.identifier);
      blockedBy.get(target.identifier)!.push(issue.identifier);
    }
  }
  for (const list of [...blocks.values(), ...blockedBy.values()]) list.sort(compareIdentifiers);

  // --- Loops: find the edges that close a loop and set them aside --------
  const cyclic = new Set<string>();
  const visitState = new Map<string, "open" | "closed">();
  const visit = (id: string): void => {
    visitState.set(id, "open");
    for (const next of blocks.get(id)!) {
      const state = visitState.get(next);
      if (state === "open") cyclic.add(`${id}>${next}`);
      else if (state === undefined) visit(next);
    }
    visitState.set(id, "closed");
  };
  for (const id of ids) if (!visitState.has(id)) visit(id);
  if (cyclic.size > 0) warnings.push(`${cyclic.size} blocking relation(s) form a loop; they are drawn dashed`);

  const after = new Map(ids.map((id) => [id, blocks.get(id)!.filter((next) => !cyclic.has(`${id}>${next}`))]));
  const before = new Map(ids.map((id) => [id, blockedBy.get(id)!.filter((prev) => !cyclic.has(`${prev}>${id}`))]));

  // --- Columns: one further right than the last thing that blocks it -----
  const col = new Map<string, number>();
  const waitingOn = new Map(ids.map((id) => [id, before.get(id)!.length]));
  const queue = ids.filter((id) => waitingOn.get(id) === 0);
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    col.set(id, Math.max(-1, ...before.get(id)!.map((prev) => col.get(prev)!)) + 1);
    for (const next of after.get(id)!) {
      waitingOn.set(next, waitingOn.get(next)! - 1);
      if (waitingOn.get(next) === 0) queue.push(next);
    }
  }
  // An issue nothing blocks would sit in the first column with a long line to
  // what it blocks. Move it next to that instead.
  for (const id of ids) {
    if (before.get(id)!.length === 0 && after.get(id)!.length > 0) {
      col.set(id, Math.min(...after.get(id)!.map((next) => col.get(next)!)) - 1);
    }
  }
  const columns = ids.length === 0 ? 0 : Math.max(...col.values()) + 1;

  // --- Status of each issue, and which ones are collapsed to a dot ---------
  const isDone = (id: string): boolean => issueOf.get(id)!.state.type === "completed";
  const isBlocked = (id: string): boolean => !isDone(id) && blockedBy.get(id)!.some((prev) => !isDone(prev));
  const statusOf = (id: string): Status =>
    isDone(id) ? "done" : isBlocked(id) ? "blocked" : issueOf.get(id)!.state.type === "started" ? "started" : "ready";
  const isCollapsed = (id: string): boolean => collapse.has(statusOf(id));

  // --- Slots: every column holds cards or dots, plus a thin slot for each line passing through
  type Slot = { key: string; room: number };
  const layers: Slot[][] = Array.from({ length: columns }, () => []);
  const left = new Map<string, string[]>(); // slot -> slots it connects to in the column before
  const right = new Map<string, string[]>(); // slot -> slots it connects to in the column after
  const connect = (a: string, b: string): void => {
    right.set(a, [...(right.get(a) ?? []), b]);
    left.set(b, [...(left.get(b) ?? []), a]);
  };
  const milestoneOrder = (id: string): number => issueOf.get(id)!.projectMilestone?.sortOrder ?? Number.MAX_VALUE;
  for (const id of [...ids].sort((a, b) => milestoneOrder(a) - milestoneOrder(b) || compareIdentifiers(a, b))) {
    layers[col.get(id)!].push({ key: id, room: isCollapsed(id) ? DOT_SLOT : CARD_SLOT });
  }
  const passes = new Map<string, string[]>(); // edge -> the thin slots it passes through
  for (const from of ids) {
    for (const to of after.get(from)!) {
      const through: string[] = [];
      let previous = from;
      for (let column = col.get(from)! + 1; column < col.get(to)!; column++) {
        const key = `${from}>${to}@${column}`;
        layers[column].push({ key, room: LINE_SLOT });
        connect(previous, key);
        through.push(key);
        previous = key;
      }
      connect(previous, to);
      passes.set(`${from}>${to}`, through);
    }
  }

  // --- Order within each column: fewest crossing lines -------------------
  const position = new Map<string, number>();
  const renumber = (): void => layers.forEach((layer) => layer.forEach((slot, index) => position.set(slot.key, index)));
  const crossings = (): number => {
    let count = 0;
    for (let column = 0; column + 1 < layers.length; column++) {
      const segments: [number, number][] = [];
      for (const slot of layers[column]) {
        for (const next of right.get(slot.key) ?? []) segments.push([position.get(slot.key)!, position.get(next)!]);
      }
      for (let a = 0; a < segments.length; a++) {
        for (let b = a + 1; b < segments.length; b++) {
          if ((segments[a][0] - segments[b][0]) * (segments[a][1] - segments[b][1]) < 0) count++;
        }
      }
    }
    return count;
  };
  const reorder = (layer: Slot[], neighbours: Map<string, string[]>): void => {
    const wanted = new Map(
      layer.map((slot) => {
        const near = neighbours.get(slot.key) ?? [];
        return [slot.key, near.length ? mean(near.map((key) => position.get(key)!)) : position.get(slot.key)!];
      }),
    );
    const was = new Map(layer.map((slot) => [slot.key, position.get(slot.key)!]));
    layer.sort((a, b) => wanted.get(a.key)! - wanted.get(b.key)! || was.get(a.key)! - was.get(b.key)!);
    layer.forEach((slot, index) => position.set(slot.key, index));
  };
  renumber();
  let best = layers.map((layer) => [...layer]);
  let fewest = crossings();
  for (let round = 0; round < 12 && fewest > 0; round++) {
    if (round % 2 === 0) for (let column = 1; column < layers.length; column++) reorder(layers[column], left);
    else for (let column = layers.length - 2; column >= 0; column--) reorder(layers[column], right);
    const now = crossings();
    if (now < fewest) {
      fewest = now;
      best = layers.map((layer) => [...layer]);
    }
  }
  best.forEach((layer, column) => (layers[column] = layer));
  renumber();
  // Then swap neighbours wherever that alone removes a crossing.
  const crossingsBetween = (above: string, below: string): number => {
    let count = 0;
    for (const neighbours of [left, right]) {
      for (const a of neighbours.get(above) ?? []) {
        for (const b of neighbours.get(below) ?? []) if (position.get(a)! > position.get(b)!) count++;
      }
    }
    return count;
  };
  for (let pass = 0, swapped = true; swapped && pass < 20; pass++) {
    swapped = false;
    for (const layer of layers) {
      for (let index = 0; index + 1 < layer.length; index++) {
        const above = layer[index];
        const below = layer[index + 1];
        if (crossingsBetween(below.key, above.key) < crossingsBetween(above.key, below.key)) {
          layer[index] = below;
          layer[index + 1] = above;
          position.set(below.key, index);
          position.set(above.key, index + 1);
          swapped = true;
        }
      }
    }
  }

  // --- Height of each slot: pull connected things level with each other --
  const y = new Map<string, number>();
  const offsets = layers.map((layer) => {
    const offset = [0];
    for (let index = 1; index < layer.length; index++) {
      offset.push(offset[index - 1] + (layer[index - 1].room + layer[index].room) / 2 + SLOT_GAP);
    }
    return offset;
  });
  layers.forEach((layer, column) => {
    const middle = (offsets[column][layer.length - 1] ?? 0) / 2;
    layer.forEach((slot, index) => y.set(slot.key, offsets[column][index] - middle));
  });
  const settle = (column: number, neighbours: (key: string) => string[]): void => {
    const layer = layers[column];
    // How far each slot wants to move from its packed place. A slot with nothing to line up
    // with has no wish of its own and stays packed against the nearest slot that has one.
    const shift: (number | null)[] = layer.map((slot, index) => {
      const near = neighbours(slot.key);
      return near.length ? mean(near.map((key) => y.get(key)!)) - offsets[column][index] : null;
    });
    if (shift.every((value) => value === null)) return;
    const wished = shift.map((value, index) => {
      for (let distance = 0; value === null && distance < layer.length; distance++) {
        value = shift[index - distance] ?? shift[index + distance] ?? null;
      }
      return value!;
    });
    const fitted = nonDecreasingFit(wished);
    layer.forEach((slot, index) => y.set(slot.key, fitted[index] + offsets[column][index]));
  };
  const leftOf = (key: string): string[] => left.get(key) ?? [];
  const rightOf = (key: string): string[] => right.get(key) ?? [];
  for (let round = 0; round < 8; round++) {
    for (let column = 1; column < layers.length; column++) settle(column, leftOf);
    for (let column = layers.length - 2; column >= 0; column--) settle(column, rightOf);
  }
  for (let column = 0; column < layers.length; column++) settle(column, (key) => [...leftOf(key), ...rightOf(key)]);
  const top = y.size === 0 ? 0 : Math.min(...y.values());
  for (const [key, value] of y) y.set(key, round2(value - top));
  const height = ids.length === 0 ? 0 : round2(Math.max(...layers.flat().map((slot) => y.get(slot.key)!)) + 1);

  // --- Nodes -------------------------------------------------------------
  const nodes: GraphNode[] = kept.map((issue) => {
    const id = issue.identifier;
    const status = statusOf(id);
    return {
      id,
      title: issue.title,
      url: issue.url,
      state: { name: issue.state.name, type: issue.state.type },
      assignee: issue.assignee?.name ?? null,
      dueDate: issue.dueDate ?? null,
      priority: issue.priority ?? 0,
      milestone: issue.projectMilestone?.id ?? NO_MILESTONE,
      col: col.get(id)!,
      y: y.get(id)!,
      done: status === "done",
      blocked: status === "blocked",
      ready: status === "ready",
      status,
      collapsed: collapse.has(status),
      blockedBy: blockedBy.get(id)!,
      blocks: blocks.get(id)!,
    };
  });

  // --- Edges with the points their lines pass through --------------------
  const edges: GraphEdge[] = [];
  for (const from of ids) {
    for (const to of blocks.get(from)!) {
      const key = `${from}>${to}`;
      const through = cyclic.has(key) ? [] : passes.get(key)!;
      edges.push({
        from,
        to,
        cyclic: cyclic.has(key),
        points: [
          [col.get(from)!, y.get(from)!],
          ...through.map((slot, index): [number, number] => [col.get(from)! + 1 + index, y.get(slot)!]),
          [col.get(to)!, y.get(to)!],
        ],
      });
    }
  }

  // --- Progress ----------------------------------------------------------
  const milestones = new Map<string, Milestone & { order: number }>();
  for (const issue of kept) {
    const milestone = issue.projectMilestone;
    const id = milestone?.id ?? NO_MILESTONE;
    if (!milestones.has(id)) {
      milestones.set(id, {
        id,
        name: milestone?.name ?? "No milestone",
        targetDate: milestone?.targetDate ?? null,
        total: 0,
        done: 0,
        started: 0,
        order: milestone?.sortOrder ?? Number.MAX_VALUE,
      });
    }
    const entry = milestones.get(id)!;
    entry.total++;
    if (issue.state.type === "completed") entry.done++;
    if (issue.state.type === "started") entry.started++;
  }
  const ordered = [...milestones.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map(({ order: _order, ...milestone }) => milestone);

  const projects = [...new Set(kept.map((issue) => issue.project?.name).filter((name): name is string => !!name))];
  return {
    title: projects.length === 0 ? "Linear issues" : projects.slice(0, 3).join(" · "),
    nodes,
    edges,
    milestones: ordered,
    totals: {
      total: nodes.length,
      done: nodes.filter((node) => node.done).length,
      started: nodes.filter((node) => node.state.type === "started").length,
    },
    columns,
    height,
    warnings,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export type AppOptions = {
  /** Where the issues come from: linearSource(...) or fixtureSource(...). */
  source: () => Promise<LinearIssue[]>;
  /** How old the copy may get before the next request re-reads the source. Default 120. */
  refreshSeconds?: number;
  /** Shortest time between two reads of the source. Default 10. */
  minRefreshSeconds?: number;
  /** Folder with index.html and app.js. Default: public/ beside this file. */
  publicDir?: string;
  /** Where the one-line request log goes. Default: stdout. */
  log?: (line: string) => void;
  /** The clock, in milliseconds. Replaced in tests. */
  now?: () => number;
};

// The page loads nothing from anywhere else and may only talk to this server.
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; " +
    "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-cache",
};

export function createApp(options: AppOptions): Server {
  const refreshMs = (options.refreshSeconds ?? 120) * 1000;
  const minRefreshMs = (options.minRefreshSeconds ?? 10) * 1000;
  const publicDir = options.publicDir ?? join(dirname(fileURLToPath(import.meta.url)), "public");
  const log = options.log ?? ((line: string) => console.log(line));
  const now = options.now ?? (() => Date.now());

  // The whole page is two files, read once. Nothing else on disk can be asked for.
  const index = readFileSync(join(publicDir, "index.html"));
  const script = readFileSync(join(publicDir, "app.js"));
  const files = new Map<string, { type: string; body: Buffer }>([
    ["/", { type: "text/html; charset=utf-8", body: index }],
    ["/index.html", { type: "text/html; charset=utf-8", body: index }],
    ["/app.js", { type: "text/javascript; charset=utf-8", body: script }],
  ]);

  let issues: LinearIssue[] | null = null; // the last good read
  const graphs = new Map<string, Graph>(); // the graph for each set of collapsed statuses, built when first asked for
  let lastSync: number | null = null; // when the source was last read successfully
  let lastAttempt: number | null = null;
  let syncError: string | null = null;
  let running: Promise<void> | null = null;

  /** Read the source once. Calls made while one is running share it. */
  const refresh = (): Promise<void> => {
    if (running) return running;
    lastAttempt = now();
    running = options
      .source()
      .then((read) => {
        issues = read;
        graphs.clear();
        lastSync = now();
        syncError = null;
      })
      .catch((error: unknown) => {
        // The last good graph is kept, so a Linear outage shows old data instead of nothing.
        syncError = error instanceof Error ? error.message : String(error);
        log(`sync failed: ${syncError}`);
      })
      .finally(() => {
        running = null;
      });
    return running;
  };

  const tooSoon = (): boolean => lastAttempt !== null && now() - lastAttempt < minRefreshMs;

  /** The statuses named in ?collapse=done,blocked. Anything that is not a status is ignored. */
  const collapsedIn = (url: URL): Status[] => {
    const asked = (url.searchParams.get("collapse") ?? "").split(",");
    return STATUSES.filter((status) => asked.includes(status));
  };

  const sendGraph = (res: ServerResponse, collapsed: Status[], extra: Record<string, unknown> = {}): void => {
    if (!issues) {
      sendJson(res, 503, { error: syncError ?? "the issues have not been read yet" });
      return;
    }
    const key = collapsed.join(",");
    if (!graphs.has(key)) graphs.set(key, buildGraph(issues, { collapse: collapsed }));
    sendJson(res, 200, {
      ...graphs.get(key)!,
      collapsed,
      lastSync: new Date(lastSync!).toISOString(),
      syncError,
      refreshSeconds: refreshMs / 1000,
      ...extra,
    });
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const read = method === "GET" || method === "HEAD";

    if (path === "/healthz" && read) {
      // Says the process is up, not that Linear is reachable: restarting the pod would not fix Linear.
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end("ok\n");
      return;
    }
    if (path === "/api/graph" && read) {
      if (!issues) {
        if (!tooSoon() || running) await refresh();
      } else if (now() - lastSync! > refreshMs && !running && !tooSoon()) {
        void refresh(); // answer with the old copy now; the next request gets the new one
      }
      sendGraph(res, collapsedIn(url));
      return;
    }
    if (path === "/api/refresh" && method === "POST") {
      const throttled = !running && tooSoon();
      if (!throttled) await refresh();
      sendGraph(res, collapsedIn(url), { throttled });
      return;
    }
    const file = files.get(path);
    if (file && read) {
      res.writeHead(200, { "content-type": file.type, "content-length": file.body.length, ...PAGE_HEADERS });
      res.end(method === "HEAD" ? undefined : file.body);
      return;
    }
    if (file || path === "/healthz" || path === "/api/graph" || path === "/api/refresh") {
      sendJson(res, 405, { error: `${method} is not allowed on ${path}` });
      return;
    }
    sendJson(res, 404, { error: "not found" });
  };

  return createServer((req, res) => {
    const started = now();
    handle(req, res)
      .catch((error: unknown) => {
        log(`error: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
        else res.end();
      })
      .finally(() => {
        const path = (req.url ?? "/").split("?")[0];
        if (path !== "/healthz") log(`${req.method} ${path} ${res.statusCode} ${now() - started}ms`);
      });
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body) + "\n";
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function isMain(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST || "0.0.0.0";
  const refreshSeconds = Number(process.env.REFRESH_SECONDS ?? 120);
  const fixture = process.env.GRAPH_FIXTURE;
  const apiKey = process.env.LINEAR_API_KEY;
  const team = process.env.LINEAR_TEAM || undefined;
  const project = process.env.LINEAR_PROJECT || undefined;
  if (!fixture && !apiKey) {
    console.error("LINEAR_API_KEY is not set (or set GRAPH_FIXTURE to a JSON file to try the page without Linear)");
    process.exit(1);
  }
  const source = fixture ? fixtureSource(fixture) : linearSource({ apiKey: apiKey!, team, project });
  const server = createApp({ source, refreshSeconds });
  server.listen(port, host, () => {
    const from = fixture ? `the file ${fixture}` : `Linear (team ${team ?? "any"}, project ${project ?? "any"})`;
    console.log(`linear-graph on ${host}:${port}, reading ${from}, refreshing after ${refreshSeconds}s`);
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      server.closeIdleConnections();
    });
  }
}
