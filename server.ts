// linear-graph: a read-only dependency graph of Linear issues.
//
// Linear shows "blocked by" and "blocks" on each issue but has no picture of the
// whole chain. This server reads the issues with a read-only Linear API key,
// works out the graph (where each card goes, which issues are ready to start)
// and serves one page that draws it.
//
//   GET  /              the page (public/index.html, public/app.js)
//   GET  /api/graph     the graph as JSON; re-reads Linear when the copy is old
//                       ?collapse=done,blocked folds each of those statuses into one dot
//                       ?flow=right runs the lines left to right instead of down the page
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
  /** How far along the flow, counted from 0. Each issue is one rank past the last thing that blocks it. */
  rank: number;
  /** Position across the flow, in card widths (or card heights when the flow runs left to right), 0 at the start. */
  across: number;
  done: boolean;
  /** Not done, and at least one issue that blocks it is not done. */
  blocked: boolean;
  /** Not started, and nothing open blocks it. */
  ready: boolean;
  /** The one word the page colours by: done, blocked, started or ready. */
  status: Status;
  /** Its status is collapsed: it is not drawn, and its rank and across are those of the dot that stands for it. */
  collapsed: boolean;
  /** Every issue that blocks this one, drawn or not. */
  blockedBy: string[];
  /** Every issue this one blocks, drawn or not. */
  blocks: string[];
};

/** Every issue has exactly one of these. Blocked wins over started: work under way that is still waiting counts as blocked. */
export const STATUSES = ["ready", "started", "blocked", "done"] as const;
export type Status = (typeof STATUSES)[number];

/** Which way the blocking lines run: down the page, or left to right. */
export const FLOWS = ["down", "right"] as const;
export type Flow = (typeof FLOWS)[number];

/** The one dot that stands for every issue of a collapsed status. */
export type GraphGroup = {
  /** "group:done" and so on. Lines use this where an issue id would be. */
  id: string;
  status: Status;
  /** The issues it stands for. */
  members: string[];
  rank: number;
  across: number;
};

export type GraphEdge = {
  /** The blocking issue, or the dot it is collapsed into. */
  from: string;
  /** The issue it blocks, or the dot that is collapsed into. */
  to: string;
  /** Part of a loop (A blocks B blocks A). Drawn differently and left out of the layout. */
  cyclic: boolean;
  /** Not a relation in Linear: the two are linked only through collapsed issues in between. */
  via: boolean;
  /** [rank, across] from source to target. Long lines get one point per rank they pass. */
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
  flow: Flow;
  nodes: GraphNode[];
  groups: GraphGroup[];
  edges: GraphEdge[];
  milestones: Milestone[];
  totals: { total: number; done: number; started: number };
  /** How many ranks the flow has. */
  ranks: number;
  /** How far the widest rank reaches across, in the same unit as `across`. */
  breadth: number;
  warnings: string[];
};

const NO_MILESTONE = "none";

// Room each thing takes across the flow, where a card takes 1. A long line
// passing through a rank gets a thin slot of its own, so cards are never drawn
// on top of a line. When the flow runs down the page the unit is a card's
// width, which is much more than a line needs, so the thin slots are thinner.
const CARD_SLOT = 1;
const DOT_SLOT = { down: 0.16, right: 0.36 };
const LINE_SLOT = { down: 0.1, right: 0.3 };
const SLOT_GAP = { down: 0.07, right: 0.08 };

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
 * move the things in a rank toward where they want to be without letting
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

/**
 * Turn Linear's issues into things with positions, the lines between them, and progress counts.
 * collapse: statuses whose issues are folded into one dot each. flow: which way the lines run.
 */
export function buildGraph(issues: LinearIssue[], options: { collapse?: Iterable<Status>; flow?: Flow } = {}): Graph {
  const collapse = new Set(options.collapse ?? []);
  const flow: Flow = options.flow ?? "down";
  const warnings: string[] = [];
  // Cancelled and duplicate issues are left out: they are neither work to do nor work done.
  const kept = issues
    .filter((issue) => issue.state.type !== "canceled")
    .sort((a, b) => compareIdentifiers(a.identifier, b.identifier));
  const byLinearId = new Map(kept.map((issue) => [issue.id, issue]));
  const issueOf = new Map(kept.map((issue) => [issue.identifier, issue]));
  const ids = kept.map((issue) => issue.identifier);

  // --- Relations: "A blocks B", as Linear has them -----------------------
  const blocks = new Map<string, string[]>(ids.map((id) => [id, []]));
  const blockedBy = new Map<string, string[]>(ids.map((id) => [id, []]));
  const relationKeys = new Set<string>();
  for (const issue of kept) {
    if (issue.relations?.pageInfo?.hasNextPage) {
      warnings.push(`${issue.identifier} has more relations than were read; some of its lines may be missing`);
    }
    for (const relation of issue.relations?.nodes ?? []) {
      if (relation.type !== "blocks") continue;
      const target = byLinearId.get(relation.relatedIssue.id);
      if (!target || target.id === issue.id) continue;
      const key = `${issue.identifier}>${target.identifier}`;
      if (relationKeys.has(key)) continue;
      relationKeys.add(key);
      blocks.get(issue.identifier)!.push(target.identifier);
      blockedBy.get(target.identifier)!.push(issue.identifier);
    }
  }
  for (const list of [...blocks.values(), ...blockedBy.values()]) list.sort(compareIdentifiers);

  // --- Status of each issue, and which ones are collapsed ----------------
  const isDone = (id: string): boolean => issueOf.get(id)!.state.type === "completed";
  const isBlocked = (id: string): boolean => !isDone(id) && blockedBy.get(id)!.some((prev) => !isDone(prev));
  const statusOf = (id: string): Status =>
    isDone(id) ? "done" : isBlocked(id) ? "blocked" : issueOf.get(id)!.state.type === "started" ? "started" : "ready";
  const hidden = new Set(ids.filter((id) => collapse.has(statusOf(id))));
  const shown = ids.filter((id) => !hidden.has(id));
  const groupOf = (id: string): string => `group:${statusOf(id)}`;
  const groupIds = STATUSES.map((status) => `group:${status}`).filter((group) => ids.some((id) => hidden.has(id) && groupOf(id) === group));
  const isGroup = (item: string): boolean => item.startsWith("group:");
  /** What is drawn for an issue: itself, or the dot it is collapsed into. */
  const itemOf = (id: string): string => (hidden.has(id) ? groupOf(id) : id);
  /** Everything the layout places: the issues still shown, then one dot per collapsed status. */
  const items = [...shown, ...groupIds];

  // --- Lines between the things that are drawn ---------------------------
  type Line = { from: string; to: string; via: boolean };
  const lines = new Map<string, Line>();
  const addLine = (from: string, to: string, via: boolean): void => {
    if (from === to) return;
    const key = `${from}>${to}`;
    const existing = lines.get(key);
    if (!existing) lines.set(key, { from, to, via });
    else if (!via) existing.via = false;
  };
  for (const from of ids) for (const to of blocks.get(from)!) addLine(itemOf(from), itemOf(to), false);
  // Two shown issues linked only through collapsed ones keep a line, marked as indirect.
  for (const from of shown) {
    const seen = new Set<string>();
    const queue = blocks.get(from)!.filter((id) => hidden.has(id));
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const next of blocks.get(id)!) {
        if (hidden.has(next)) queue.push(next);
        else if (next !== from) addLine(from, next, true);
      }
    }
  }
  // A dot stands for several issues, so the same card can sit both before and after it.
  // Keep the dot before the card and drop the line back into it; otherwise it would be a loop.
  for (const group of groupIds) {
    const reached = new Set<string>();
    const queue = [group];
    while (queue.length > 0) {
      const at = queue.pop()!;
      for (const line of lines.values()) {
        if (line.from === at && line.to !== group && !reached.has(line.to)) {
          reached.add(line.to);
          queue.push(line.to);
        }
      }
    }
    for (const [key, line] of lines) if (line.to === group && reached.has(line.from)) lines.delete(key);
  }
  const compareItems = (a: string, b: string): number =>
    isGroup(a) !== isGroup(b) ? (isGroup(a) ? 1 : -1) : isGroup(a) ? groupIds.indexOf(a) - groupIds.indexOf(b) : compareIdentifiers(a, b);
  const outOf = new Map<string, string[]>(items.map((item) => [item, []]));
  const into = new Map<string, string[]>(items.map((item) => [item, []]));
  for (const line of lines.values()) {
    outOf.get(line.from)!.push(line.to);
    into.get(line.to)!.push(line.from);
  }
  for (const list of [...outOf.values(), ...into.values()]) list.sort(compareItems);

  // --- Loops: find the lines that close a loop and set them aside --------
  const cyclic = new Set<string>();
  const visitState = new Map<string, "open" | "closed">();
  const visit = (item: string): void => {
    visitState.set(item, "open");
    for (const next of outOf.get(item)!) {
      const state = visitState.get(next);
      if (state === "open") cyclic.add(`${item}>${next}`);
      else if (state === undefined) visit(next);
    }
    visitState.set(item, "closed");
  };
  for (const item of items) if (!visitState.has(item)) visit(item);
  if (cyclic.size > 0) warnings.push(`${cyclic.size} blocking relation(s) form a loop; they are drawn dashed`);

  const after = new Map(items.map((item) => [item, outOf.get(item)!.filter((next) => !cyclic.has(`${item}>${next}`))]));
  const before = new Map(items.map((item) => [item, into.get(item)!.filter((prev) => !cyclic.has(`${prev}>${item}`))]));

  // --- Ranks: one further along than the last thing that blocks it -------
  const rank = new Map<string, number>();
  const waitingOn = new Map(items.map((item) => [item, before.get(item)!.length]));
  const queue = items.filter((item) => waitingOn.get(item) === 0);
  for (let head = 0; head < queue.length; head++) {
    const item = queue[head];
    rank.set(item, Math.max(-1, ...before.get(item)!.map((prev) => rank.get(prev)!)) + 1);
    for (const next of after.get(item)!) {
      waitingOn.set(next, waitingOn.get(next)! - 1);
      if (waitingOn.get(next) === 0) queue.push(next);
    }
  }
  // Something nothing blocks would sit in the first rank with a long line to
  // what it blocks. Move it next to that instead.
  for (const item of items) {
    if (before.get(item)!.length === 0 && after.get(item)!.length > 0) {
      rank.set(item, Math.min(...after.get(item)!.map((next) => rank.get(next)!)) - 1);
    }
  }
  const ranks = items.length === 0 ? 0 : Math.max(...rank.values()) + 1;

  // --- Slots: every rank holds cards and dots, plus a thin slot for each line passing through
  type Slot = { key: string; room: number };
  const layers: Slot[][] = Array.from({ length: ranks }, () => []);
  const backward = new Map<string, string[]>(); // slot -> slots it connects to in the rank before
  const forward = new Map<string, string[]>(); // slot -> slots it connects to in the rank after
  const connect = (a: string, b: string): void => {
    forward.set(a, [...(forward.get(a) ?? []), b]);
    backward.set(b, [...(backward.get(b) ?? []), a]);
  };
  const milestoneOrder = (item: string): number =>
    isGroup(item) ? -1 : (issueOf.get(item)!.projectMilestone?.sortOrder ?? Number.MAX_VALUE);
  for (const item of [...items].sort((a, b) => milestoneOrder(a) - milestoneOrder(b) || compareItems(a, b))) {
    layers[rank.get(item)!].push({ key: item, room: isGroup(item) ? DOT_SLOT[flow] : CARD_SLOT });
  }
  const passes = new Map<string, string[]>(); // line -> the thin slots it passes through
  for (const from of items) {
    for (const to of after.get(from)!) {
      const through: string[] = [];
      let previous = from;
      for (let at = rank.get(from)! + 1; at < rank.get(to)!; at++) {
        const key = `${from}>${to}@${at}`;
        layers[at].push({ key, room: LINE_SLOT[flow] });
        connect(previous, key);
        through.push(key);
        previous = key;
      }
      connect(previous, to);
      passes.set(`${from}>${to}`, through);
    }
  }

  // --- Order within each rank: fewest crossing lines ---------------------
  const position = new Map<string, number>();
  const renumber = (): void => layers.forEach((layer) => layer.forEach((slot, index) => position.set(slot.key, index)));
  const crossings = (): number => {
    let count = 0;
    for (let at = 0; at + 1 < layers.length; at++) {
      const segments: [number, number][] = [];
      for (const slot of layers[at]) {
        for (const next of forward.get(slot.key) ?? []) segments.push([position.get(slot.key)!, position.get(next)!]);
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
    if (round % 2 === 0) for (let at = 1; at < layers.length; at++) reorder(layers[at], backward);
    else for (let at = layers.length - 2; at >= 0; at--) reorder(layers[at], forward);
    const now = crossings();
    if (now < fewest) {
      fewest = now;
      best = layers.map((layer) => [...layer]);
    }
  }
  best.forEach((layer, at) => (layers[at] = layer));
  renumber();
  // Then swap neighbours wherever that alone removes a crossing.
  const crossingsBetween = (first: string, second: string): number => {
    let count = 0;
    for (const neighbours of [backward, forward]) {
      for (const a of neighbours.get(first) ?? []) {
        for (const b of neighbours.get(second) ?? []) if (position.get(a)! > position.get(b)!) count++;
      }
    }
    return count;
  };
  for (let pass = 0, swapped = true; swapped && pass < 20; pass++) {
    swapped = false;
    for (const layer of layers) {
      for (let index = 0; index + 1 < layer.length; index++) {
        const first = layer[index];
        const second = layer[index + 1];
        if (crossingsBetween(second.key, first.key) < crossingsBetween(first.key, second.key)) {
          layer[index] = second;
          layer[index + 1] = first;
          position.set(second.key, index);
          position.set(first.key, index + 1);
          swapped = true;
        }
      }
    }
  }

  // --- Place each slot across the flow: pull connected things into line --
  const across = new Map<string, number>();
  const offsets = layers.map((layer) => {
    const offset = [0];
    for (let index = 1; index < layer.length; index++) {
      offset.push(offset[index - 1] + (layer[index - 1].room + layer[index].room) / 2 + SLOT_GAP[flow]);
    }
    return offset;
  });
  layers.forEach((layer, at) => {
    const middle = (offsets[at][layer.length - 1] ?? 0) / 2;
    layer.forEach((slot, index) => across.set(slot.key, offsets[at][index] - middle));
  });
  const settle = (at: number, neighbours: (key: string) => string[]): void => {
    const layer = layers[at];
    // How far each slot wants to move from its packed place. A slot with nothing to line up
    // with has no wish of its own and stays packed against the nearest slot that has one.
    const shift: (number | null)[] = layer.map((slot, index) => {
      const near = neighbours(slot.key);
      return near.length ? mean(near.map((key) => across.get(key)!)) - offsets[at][index] : null;
    });
    if (shift.every((value) => value === null)) return;
    const wished = shift.map((value, index) => {
      for (let distance = 0; value === null && distance < layer.length; distance++) {
        value = shift[index - distance] ?? shift[index + distance] ?? null;
      }
      return value!;
    });
    const fitted = nonDecreasingFit(wished);
    layer.forEach((slot, index) => across.set(slot.key, fitted[index] + offsets[at][index]));
  };
  const backwardOf = (key: string): string[] => backward.get(key) ?? [];
  const forwardOf = (key: string): string[] => forward.get(key) ?? [];
  for (let round = 0; round < 8; round++) {
    for (let at = 1; at < layers.length; at++) settle(at, backwardOf);
    for (let at = layers.length - 2; at >= 0; at--) settle(at, forwardOf);
  }
  for (let at = 0; at < layers.length; at++) settle(at, (key) => [...backwardOf(key), ...forwardOf(key)]);
  const start = across.size === 0 ? 0 : Math.min(...across.values());
  for (const [key, value] of across) across.set(key, round2(value - start));
  const breadth = items.length === 0 ? 0 : round2(Math.max(...layers.flat().map((slot) => across.get(slot.key)!)) + 1);

  // --- Nodes and the dots that stand for collapsed ones -------------------
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
      rank: rank.get(itemOf(id))!,
      across: across.get(itemOf(id))!,
      done: status === "done",
      blocked: status === "blocked",
      ready: status === "ready",
      status,
      collapsed: hidden.has(id),
      blockedBy: blockedBy.get(id)!,
      blocks: blocks.get(id)!,
    };
  });
  const groups: GraphGroup[] = groupIds.map((group) => ({
    id: group,
    status: group.slice("group:".length) as Status,
    members: ids.filter((id) => hidden.has(id) && groupOf(id) === group),
    rank: rank.get(group)!,
    across: across.get(group)!,
  }));

  // --- Edges with the points their lines pass through --------------------
  const edges: GraphEdge[] = [];
  for (const from of items) {
    for (const to of outOf.get(from)!) {
      const key = `${from}>${to}`;
      const through = cyclic.has(key) ? [] : passes.get(key)!;
      edges.push({
        from,
        to,
        cyclic: cyclic.has(key),
        via: lines.get(key)!.via,
        points: [
          [rank.get(from)!, across.get(from)!],
          ...through.map((slot, index): [number, number] => [rank.get(from)! + 1 + index, across.get(slot)!]),
          [rank.get(to)!, across.get(to)!],
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
    flow,
    nodes,
    groups,
    edges,
    milestones: ordered,
    totals: {
      total: nodes.length,
      done: nodes.filter((node) => node.done).length,
      started: nodes.filter((node) => node.state.type === "started").length,
    },
    ranks,
    breadth,
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
  const graphs = new Map<string, Graph>(); // the graph for each way of drawing it, built when first asked for
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

  const flowIn = (url: URL): Flow => (url.searchParams.get("flow") === "right" ? "right" : "down");

  const sendGraph = (res: ServerResponse, url: URL, extra: Record<string, unknown> = {}): void => {
    if (!issues) {
      sendJson(res, 503, { error: syncError ?? "the issues have not been read yet" });
      return;
    }
    const collapsed = collapsedIn(url);
    const flow = flowIn(url);
    const key = `${flow}|${collapsed.join(",")}`;
    if (!graphs.has(key)) graphs.set(key, buildGraph(issues, { collapse: collapsed, flow }));
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
      sendGraph(res, url);
      return;
    }
    if (path === "/api/refresh" && method === "POST") {
      const throttled = !running && tooSoon();
      if (!throttled) await refresh();
      sendGraph(res, url, { throttled });
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
