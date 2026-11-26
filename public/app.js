// The page. Asks the server for the graph (GET /api/graph) and draws it:
// cards are HTML, the lines between them are one SVG underneath.
// The server splits issues into connected dependency clusters (laid out by
// rank and across) and standalone issues (no blockers); this file packs the
// clusters to fit the viewport, lays out the sortable standalone grid, and
// turns everything into pixels. Everything from Linear is put on the page as
// text, never as HTML.

const CARD_W = 232;
const CARD_H = 90;
const PAD = 24;
const GRID_GAP_X = 14;
const GRID_GAP_Y = 14;
// Pixels for one unit of the server's "across". A card takes one unit, so this is its size plus breathing room.
const UNIT = { down: CARD_W + 12, right: CARD_H + 10 };
// Room between two ranks, where the lines bend.
const RANK_GAP = { down: 56, right: 62 };
const DOT_RANK = 44; // size along the flow of a rank that holds only dots
const DOT_R = 15; // radius of the dot a collapsed status folds into
const CLUSTER_PAD = 18;
const CLUSTER_HEADER = 26;
const MIN_ZOOM = 0.14;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.3; // one press of + or −
const FIT_MARGIN = 36; // room left around the graph when it is fitted to the window
const DRAG_START = 5; // how far the pointer must move before a press counts as a drag
const MAP_W = 210;
const MAP_H = 150;
const MOVE_MS = 300; // how long cards take to slide to a new place
const POLL_MS = 60_000;

const MILESTONE_COLOURS = ["#7c9cff", "#c58af9", "#4fc3c8", "#f28b82", "#d4c15a", "#8bc34a", "#ff9e64", "#90a4ae", "#f48fb1", "#80cbc4"];
const PRIORITIES = ["None", "Urgent", "High", "Medium", "Low"];
const PRIORITY_RANK = [5, 1, 2, 3, 4]; // Urgent(1) first, None(0) last
const STATUSES = { ready: "Ready", started: "In progress", blocked: "Blocked", done: "Done" };
const STATUS_ORDER = { ready: 0, started: 1, blocked: 2, done: 3 };
const STANDALONE_SORTS = {
  milestone: "Milestone",
  id: "Issue #",
  status: "Status",
  priority: "Priority",
  due: "Due date",
};

const COLLAPSED_KEY = "linear-graph.collapsed";
const FLOW_KEY = "linear-graph.flow";
const PROJECT_KEY = "linear-graph.project";
const SORT_KEY = "linear-graph.standaloneSort";
const HIDE_STANDALONE_KEY = "linear-graph.hideStandalone";
const SVG = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const view = {
  title: $("title"),
  project: $("project"),
  sync: $("sync"),
  refresh: $("refresh"),
  summary: $("summary"),
  notes: $("notes"),
  message: $("message"),
  stage: $("stage"),
  canvas: $("canvas"),
  zones: $("zones"),
  zoomOut: $("zoom-out"),
  zoomIn: $("zoom-in"),
  zoomFit: $("zoom-fit"),
  flow: $("flow"),
  minimap: $("minimap"),
  mapNodes: $("map-nodes"),
  mapView: $("map-view"),
  edges: $("edges"),
  cards: $("cards"),
  detail: $("detail"),
};

let graph = null;
let layout = null;
// All configured projects from /api/projects, and which one is open.
let projects = [];
let activeProject = new URLSearchParams(location.search).get("project") || null;
let loadSeq = 0;
// The server's page version when this page loaded. A different one later means a deploy happened.
let pageVersion = null;
// What is selected: an issue ("CS1-14") or a collapsed status's dot ("group:done").
let selected = decodeURIComponent(location.hash.slice(1)) || null;
// Active milestone filter (milestone id, or null for all).
let milestoneFilter = null;
// Where the sheet sits: x, y is its top-left corner inside the stage, k is the scale (1 = full size).
const viewport = { x: 0, y: 0, k: 1 };
// True until the sheet is moved or zoomed by hand. While true, it is re-fitted when the window changes.
let fitted = true;
// Set when the layout was changed on purpose (collapse, flow, hide/show): the next draw frames the new graph.
let refitNext = false;
// Size of the whole sheet at full size.
const world = { width: 0, height: 0 };
// Every card and dot on the sheet, by id, so a redraw can slide them instead of replacing them.
const drawn = new Map();
// User preferences remembered in this browser.
const collapsed = new Set(stored(COLLAPSED_KEY, []).filter((status) => status in STATUSES));
let flow = stored(FLOW_KEY, "down") === "right" ? "right" : "down";
let standaloneSort = stored(SORT_KEY, "milestone") in STANDALONE_SORTS ? stored(SORT_KEY, "milestone") : "milestone";
let hideStandalone = Boolean(stored(HIDE_STANDALONE_KEY, false));

function stored(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private windows may refuse; the choice then lasts until the page is closed.
  }
}

function toggleCollapsed(status) {
  if (!collapsed.delete(status)) collapsed.add(status);
  store(COLLAPSED_KEY, [...collapsed]);
  if (selected === `group:${status}`) selected = null;
  refitNext = true;
  load();
}

function toggleFlow() {
  flow = flow === "down" ? "right" : "down";
  store(FLOW_KEY, flow);
  refitNext = true;
  load();
}

function setStandaloneSort(next) {
  if (!(next in STANDALONE_SORTS) || next === standaloneSort) return;
  standaloneSort = next;
  store(SORT_KEY, next);
  drawGraph();
}

function toggleHideStandalone() {
  hideStandalone = !hideStandalone;
  store(HIDE_STANDALONE_KEY, hideStandalone);
  refitNext = true;
  drawNotes();
  drawGraph();
}

/** Make an element. props: class, text, title, and any other attribute. */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

// --- Dates & sorting -------------------------------------------------------

/** "2026-12-07" as a local date, so it does not slip a day in other time zones. */
function parseDay(text) {
  const [year, month, day] = text.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function shortDay(text) {
  return parseDay(text).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function isPast(text) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseDay(text) < today;
}

function ago(iso, compact = false) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return compact ? "now" : "just now";
  if (minutes < 60) return compact ? `${minutes}m ago` : `${minutes} min ago`;
  return compact
    ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : `at ${new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function compareIds(a, b) {
  const dashA = a.lastIndexOf("-");
  const dashB = b.lastIndexOf("-");
  const teamA = a.slice(0, dashA);
  const teamB = b.slice(0, dashB);
  if (teamA !== teamB) return teamA < teamB ? -1 : 1;
  return (Number(a.slice(dashA + 1)) || 0) - (Number(b.slice(dashB + 1)) || 0);
}

// --- Projects & URL --------------------------------------------------------

function syncUrl(push = false) {
  const params = new URLSearchParams(location.search);
  if (projects.length > 1 && activeProject) params.set("project", activeProject);
  else params.delete("project");
  const query = params.toString() ? `?${params}` : "";
  const hash = selected ? `#${encodeURIComponent(selected)}` : "";
  const target = `${location.pathname}${query}${hash}`;
  if (target === `${location.pathname}${location.search}${location.hash}`) return;
  if (push) history.pushState(null, "", target);
  else history.replaceState(null, "", target);
}

function drawProjects() {
  const multi = projects.length > 1;
  view.title.hidden = multi;
  view.project.hidden = !multi;
  if (!multi) return;
  view.project.replaceChildren(...projects.map((entry) => el("option", { value: entry.id, text: entry.name })));
  if (activeProject) view.project.value = activeProject;
}

function switchProject(id, { push = true, nextSelected = null } = {}) {
  if (!id || (id === activeProject && graph !== null)) return;
  activeProject = id;
  store(PROJECT_KEY, id);
  selected = nextSelected;
  milestoneFilter = null;
  graph = null;
  layout = null;
  drawn.clear();
  view.zones.replaceChildren();
  view.cards.replaceChildren();
  view.edges.replaceChildren();
  view.summary.replaceChildren();
  view.notes.replaceChildren();
  view.detail.hidden = true;
  view.detail.replaceChildren();
  view.minimap.style.display = "none";
  view.message.textContent = "Reading the issues…";
  view.message.hidden = false;
  view.sync.textContent = "";
  view.sync.className = "";
  fitted = true;
  refitNext = true;
  if (projects.length > 1) view.project.value = id;
  syncUrl(push);
  load();
}

// --- Loading ---------------------------------------------------------------

async function init() {
  try {
    const response = await fetch("/api/projects");
    if (response.ok) {
      const body = await response.json();
      pageVersion = body.appVersion ?? null;
      projects = Array.isArray(body.projects) ? body.projects : [];
      const fromUrl = new URLSearchParams(location.search).get("project");
      const fromStorage = stored(PROJECT_KEY, null);
      const valid = (id) => Boolean(id && projects.some((entry) => entry.id === id));
      if (valid(fromUrl)) activeProject = fromUrl;
      else if (valid(fromStorage)) activeProject = fromStorage;
      else activeProject = projects[0]?.id ?? null;
      if (activeProject) store(PROJECT_KEY, activeProject);
      drawProjects();
      syncUrl(false);
    }
  } catch {
    // Fall through so load() shows the connection error in the usual place.
  }
  await load();
}

async function load(refresh = false) {
  const seq = ++loadSeq;
  try {
    const query = new URLSearchParams();
    if (activeProject) query.set("project", activeProject);
    if (collapsed.size) query.set("collapse", [...collapsed].join(","));
    if (flow === "right") query.set("flow", "right");
    const response = await fetch(`${refresh ? "/api/refresh" : "/api/graph"}?${query}`, { method: refresh ? "POST" : "GET" });
    const body = await response.json();
    if (seq !== loadSeq) return;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    // A new version was deployed since this page loaded: reload rather than draw new data with old code.
    if (body.appVersion && pageVersion && body.appVersion !== pageVersion) {
      location.reload();
      return;
    }
    pageVersion ??= body.appVersion ?? null;
    if (Array.isArray(body.projects) && JSON.stringify(body.projects) !== JSON.stringify(projects)) {
      projects = body.projects;
      drawProjects();
    }
    if (body.project?.id) activeProject = body.project.id;
    graph = body;
    if (selected && !thing(selected)) selected = null;
    if (milestoneFilter && !graph.milestones.some((m) => m.id === milestoneFilter)) milestoneFilter = null;
    draw();
  } catch (error) {
    if (seq !== loadSeq) return;
    view.sync.textContent = `Could not load: ${error.message}`;
    view.sync.className = "failing";
    if (!graph) view.message.textContent = `Could not read the issues: ${error.message}`;
  }
}

function showSync() {
  if (!graph) return;
  const compact = window.innerWidth <= 640;
  if (graph.syncError) {
    view.sync.textContent = compact
      ? `Sync error (${ago(graph.lastSync, true)})`
      : `Linear could not be read (${graph.syncError}). Showing what was read ${ago(graph.lastSync)}.`;
    view.sync.className = "failing";
  } else {
    view.sync.textContent = compact ? ago(graph.lastSync, true) : `Read from Linear ${ago(graph.lastSync)}`;
    view.sync.className = "";
  }
}

// --- Looking things up -----------------------------------------------------

const isGroup = (id) => id.startsWith("group:");

function byId(id) {
  return graph.nodes.find((node) => node.id === id);
}

function groupById(id) {
  return graph.groups.find((group) => group.id === id);
}

/** An issue or a dot, whichever the id names. */
function thing(id) {
  return isGroup(id) ? groupById(id) : byId(id);
}

/** What is drawn for an id: the issue's own card, or the dot it is folded into. */
function drawnIdOf(id) {
  if (isGroup(id)) return id;
  const node = byId(id);
  return node?.collapsed ? `group:${node.status}` : id;
}

function statusText(node) {
  if (node.done) return node.state.name;
  if (node.blocked) {
    const open = node.blockedBy.filter((id) => !byId(id).done).length;
    return node.state.type === "started" ? `${node.state.name} · blocked by ${open}` : `Blocked by ${open}`;
  }
  if (node.state.type === "started") return node.state.name;
  return node.ready ? "Ready to start" : node.state.name;
}

function milestoneIndex(id) {
  const index = graph.milestones.findIndex((milestone) => milestone.id === id);
  return index === -1 ? 999 : index;
}

function milestoneColour(id) {
  return MILESTONE_COLOURS[milestoneIndex(id) % MILESTONE_COLOURS.length];
}

function milestoneName(id) {
  return graph.milestones.find((milestone) => milestone.id === id)?.name ?? "No milestone";
}

// --- Geometry: clustered 2D packing + sortable standalone grid ---------------

const point = (along, across) => (flow === "down" ? [across, along] : [along, across]);
const cardAlong = () => (flow === "down" ? CARD_H : CARD_W);
const cardAcross = () => (flow === "down" ? CARD_W : CARD_H);
const acrossMid = (across) => across * UNIT[flow] + cardAcross() / 2;

function layoutCluster(cluster) {
  const itemSet = new Set(cluster.items);
  const clusterNodes = graph.nodes.filter((node) => !node.collapsed && itemSet.has(node.id));
  const ranks = [];
  let start = 0;
  for (let r = 0; r < cluster.ranks; r++) {
    const hasCard = clusterNodes.some((node) => node.rank === r);
    const size = hasCard ? cardAlong() : DOT_RANK;
    ranks.push({ start, size });
    start += size + RANK_GAP[flow];
  }
  const along = Math.max(0, start - RANK_GAP[flow]);
  const across = Math.max(0, cluster.breadth - 1) * UNIT[flow] + cardAcross();
  const [innerW, innerH] = point(along, across);

  const items = new Map();
  for (const id of cluster.items) {
    const item = thing(id);
    const r = ranks[item.rank];
    const mid = acrossMid(item.across);
    const dot = isGroup(id);
    const posAlong = dot ? r.start + r.size / 2 - DOT_R : r.start;
    const length = dot ? DOT_R * 2 : cardAlong();
    const breadth = dot ? DOT_R * 2 : cardAcross();
    const [left, top] = point(posAlong, mid - breadth / 2);
    const [width, height] = point(length, breadth);
    items.set(id, { left, top, width, height });
  }

  // Primary milestone colour for the cluster header dot.
  const counts = new Map();
  for (const node of clusterNodes) counts.set(node.milestone, (counts.get(node.milestone) ?? 0) + 1);
  const topMilestone = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none";

  return { cluster, ranks, items, innerW, innerH, topMilestone };
}

/** 2D shelf packer that searches row widths to best match the viewport's aspect ratio. */
function packShelves(boxes, targetAspect, gapX = 24, gapY = 24) {
  if (boxes.length === 0) return { items: [], width: 0, height: 0 };
  const maxW = Math.max(...boxes.map((b) => b.width));
  const sumW = boxes.reduce((s, b) => s + b.width, 0) + gapX * (boxes.length - 1);

  const tryWidth = (limit) => {
    const shelves = [];
    const items = [];
    for (const box of boxes) {
      let placed = false;
      for (const shelf of shelves) {
        if (shelf.x + gapX + box.width <= limit && box.height <= shelf.h * 1.2) {
          items.push({ box, x: shelf.x + gapX, shelf });
          shelf.x += gapX + box.width;
          shelf.h = Math.max(shelf.h, box.height);
          placed = true;
          break;
        }
      }
      if (!placed) {
        const shelf = { x: box.width, h: box.height, y: 0 };
        shelves.push(shelf);
        items.push({ box, x: 0, shelf });
      }
    }
    let y = 0;
    for (const shelf of shelves) {
      shelf.y = y;
      y += shelf.h + gapY;
    }
    let width = 0;
    let height = Math.max(0, y - gapY);
    const positioned = items.map((it) => {
      width = Math.max(width, it.x + it.box.width);
      height = Math.max(height, it.shelf.y + it.box.height);
      return { box: it.box, x: it.x, y: it.shelf.y };
    });
    return { items: positioned, width, height };
  };

  const candidates = new Set([maxW, sumW]);
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    candidates.add(Math.round(maxW + (sumW - maxW) * t * t));
  }
  const area = boxes.reduce((s, b) => s + b.width * b.height, 0);
  const idealW = Math.sqrt(area * targetAspect);
  for (const mult of [0.7, 0.85, 1.0, 1.15, 1.35, 1.6]) {
    candidates.add(Math.max(maxW, Math.round(idealW * mult)));
  }

  let best = null;
  let bestScore = Infinity;
  for (const widthLimit of candidates) {
    const result = tryWidth(widthLimit);
    const aspect = result.width / Math.max(1, result.height);
    const aspectErr = Math.abs(Math.log(aspect / targetAspect));
    const fill = area / Math.max(1, result.width * result.height);
    const score = aspectErr + (1 - fill) * 0.45;
    if (score < bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best;
}

function sortStandalone(ids) {
  const list = [...ids];
  const nodeKey = (id) => (isGroup(id) ? null : byId(id));
  list.sort((a, b) => {
    const na = nodeKey(a);
    const nb = nodeKey(b);
    if (!na !== !nb) return na ? -1 : 1; // put any standalone collapsed dot at the end
    if (!na && !nb) return a < b ? -1 : 1;
    if (standaloneSort === "id") return compareIds(na.id, nb.id);
    if (standaloneSort === "status") {
      return STATUS_ORDER[na.status] - STATUS_ORDER[nb.status] || milestoneIndex(na.milestone) - milestoneIndex(nb.milestone) || compareIds(na.id, nb.id);
    }
    if (standaloneSort === "priority") {
      const pa = PRIORITY_RANK[na.priority] ?? 5;
      const pb = PRIORITY_RANK[nb.priority] ?? 5;
      return pa - pb || milestoneIndex(na.milestone) - milestoneIndex(nb.milestone) || compareIds(na.id, nb.id);
    }
    if (standaloneSort === "due") {
      const da = na.dueDate ?? "9999-99-99";
      const db = nb.dueDate ?? "9999-99-99";
      return da.localeCompare(db) || milestoneIndex(na.milestone) - milestoneIndex(nb.milestone) || compareIds(na.id, nb.id);
    }
    // Default: milestone
    return milestoneIndex(na.milestone) - milestoneIndex(nb.milestone) || compareIds(na.id, nb.id);
  });
  return list;
}

function makePlace(left, top, width, height) {
  const cx = left + width / 2;
  const cy = top + height / 2;
  return {
    left,
    top,
    width,
    height,
    cx,
    cy,
    mid: flow === "down" ? cx : cy,
    enter: flow === "down" ? top : left,
    leave: flow === "down" ? top + height : left + width,
  };
}

function computeLayout() {
  const stageW = Math.max(320, view.stage.clientWidth || window.innerWidth || 1200);
  const stageH = Math.max(300, view.stage.clientHeight || window.innerHeight || 700);
  const targetAspect = Math.min(1.85, Math.max(0.55, stageW / stageH));

  const placed = new Map();
  const clusterMeta = new Map();
  const zones = [];
  const headings = [];

  const clusters = graph.clusters ?? [];
  const standaloneRaw = graph.standalone ?? [];
  const multiCluster = clusters.length > 1;
  const showStandalone = standaloneRaw.length > 0 && !hideStandalone;

  let cursorY = PAD;
  let contentW = 0;

  if (clusters.length > 0) {
    const innerPad = multiCluster ? CLUSTER_PAD : 0;
    const headerH = multiCluster ? CLUSTER_HEADER : 0;
    const boxes = clusters.map((cluster) => {
      const laid = layoutCluster(cluster);
      return {
        laid,
        width: laid.innerW + innerPad * 2,
        height: laid.innerH + innerPad * 2 + headerH,
      };
    });

    const clusterAspect = showStandalone && stageW >= 720 ? Math.min(2.0, targetAspect * 1.2) : targetAspect;
    const packed = packShelves(boxes, clusterAspect, 22, 22);

    if (multiCluster || showStandalone) {
      const totalClusterIssues = clusters.reduce((sum, c) => {
        const count = c.items.reduce((acc, id) => acc + (isGroup(id) ? groupById(id).members.length : 1), 0);
        return sum + count;
      }, 0);
      headings.push({
        x: PAD,
        y: cursorY,
        title: "Dependency Chains",
        sub: `${clusters.length} cluster${clusters.length === 1 ? "" : "s"} · ${totalClusterIssues} issue${totalClusterIssues === 1 ? "" : "s"}`,
      });
      cursorY += 28;
    }

    for (const item of packed.items) {
      const bx = PAD + item.x;
      const by = cursorY + item.y;
      const { laid } = item.box;
      if (multiCluster) {
        const issueCount = laid.cluster.items.reduce((acc, id) => acc + (isGroup(id) ? groupById(id).members.length : 1), 0);
        zones.push({
          x: bx,
          y: by,
          w: item.box.width,
          h: item.box.height,
          title: `Chain ${laid.cluster.id + 1}`,
          sub: `${issueCount} issues`,
          dot: milestoneColour(laid.topMilestone),
        });
      }
      const ox = bx + innerPad;
      const oy = by + innerPad + headerH;
      clusterMeta.set(laid.cluster.id, { ox, oy, ranks: laid.ranks });
      for (const [id, box] of laid.items) {
        placed.set(id, makePlace(ox + box.left, oy + box.top, box.width, box.height));
      }
    }
    contentW = Math.max(contentW, packed.width);
    cursorY += packed.height + (showStandalone ? 34 : PAD);
  }

  if (showStandalone) {
    const sorted = sortStandalone(standaloneRaw);
    const boxPad = 16;
    let cols;
    if (stageW < 560) {
      cols = Math.min(sorted.length, Math.max(1, Math.floor((stageW - 48) / (CARD_W * 0.72))));
    } else {
      const idealW = Math.max(
        contentW - boxPad * 2,
        Math.sqrt(sorted.length * (CARD_W + GRID_GAP_X) * (CARD_H + GRID_GAP_Y) * targetAspect),
      );
      cols = Math.max(2, Math.min(sorted.length, 8, Math.round(idealW / (CARD_W + GRID_GAP_X))));
    }
    const rows = Math.ceil(sorted.length / cols);
    const gridW = cols * CARD_W + (cols - 1) * GRID_GAP_X;
    const gridH = rows * CARD_H + (rows - 1) * GRID_GAP_Y;
    const standaloneIssueCount = sorted.reduce((acc, id) => acc + (isGroup(id) ? groupById(id).members.length : 1), 0);

    headings.push({
      x: PAD,
      y: cursorY,
      title: "Standalone (No Blockers)",
      sub: `${standaloneIssueCount} issue${standaloneIssueCount === 1 ? "" : "s"} · sorted by ${STANDALONE_SORTS[standaloneSort]}`,
    });
    cursorY += 28;
    zones.push({
      x: PAD,
      y: cursorY,
      w: gridW + boxPad * 2,
      h: gridH + boxPad * 2,
      dashed: true,
    });

    sorted.forEach((id, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const cellX = PAD + boxPad + col * (CARD_W + GRID_GAP_X);
      const cellY = cursorY + boxPad + row * (CARD_H + GRID_GAP_Y);
      if (isGroup(id)) {
        const d = DOT_R * 2;
        placed.set(id, makePlace(cellX + (CARD_W - d) / 2, cellY + (CARD_H - d) / 2, d, d));
      } else {
        placed.set(id, makePlace(cellX, cellY, CARD_W, CARD_H));
      }
    });

    contentW = Math.max(contentW, gridW + boxPad * 2);
    cursorY += gridH + boxPad * 2 + PAD;
  }

  return {
    placed,
    clusterMeta,
    zones,
    headings,
    width: Math.max(PAD * 2, contentW + PAD * 2),
    height: Math.max(PAD * 2, cursorY),
  };
}

// --- Drawing ---------------------------------------------------------------

function draw() {
  const heading = projects.length > 1 ? (graph.project?.name ?? graph.title) : graph.title;
  document.title = `${heading} · graph`;
  view.title.textContent = graph.title;
  if (projects.length > 1 && activeProject) view.project.value = activeProject;
  view.message.hidden = graph.nodes.length > 0;
  if (graph.nodes.length === 0) view.message.textContent = "No issues to show.";
  view.flow.textContent = flow === "down" ? "↓" : "→";
  view.flow.title = flow === "down" ? "Lines run down the page. Click to run them left to right." : "Lines run left to right. Click to run them down the page.";
  showSync();
  drawSummary();
  drawNotes();
  drawGraph();
  drawDetail();
}

function drawSummary() {
  if (!graph.nodes.length) {
    view.summary.replaceChildren();
    return;
  }
  const makePill = (label, counts, { msId = null, date = null } = {}) => {
    const pct = (v) => `${counts.total ? (v / counts.total) * 100 : 0}%`;
    const active = msId === null ? milestoneFilter === null : milestoneFilter === msId;
    const parts = [];
    if (msId !== null) parts.push(el("span", { class: "dot", style: `background:${milestoneColour(msId)}` }));
    parts.push(el("span", { text: label }));
    parts.push(el("span", { class: "cnt", text: `${counts.done}/${counts.total}` }));
    if (date) {
      const late = isPast(date) && counts.done < counts.total;
      parts.push(el("span", { class: late ? "date overdue" : "date", text: shortDay(date) }));
    }
    parts.push(
      el("span", { class: "prog" }, [
        el("span", { class: "done", style: `width:${pct(counts.done)}` }),
        el("span", { class: "started", style: `width:${pct(counts.started)}` }),
      ]),
    );
    const pill = el(
      "button",
      {
        class: active ? "ms-pill active" : "ms-pill",
        type: "button",
        title: msId === null ? "Show all milestones" : `Filter to ${label} (${counts.done}/${counts.total} done)`,
      },
      parts,
    );
    pill.addEventListener("click", () => {
      milestoneFilter = msId === null ? null : milestoneFilter === msId ? null : msId;
      drawSummary();
      drawGraph();
    });
    return pill;
  };

  view.summary.replaceChildren(
    makePill("All", graph.totals),
    ...graph.milestones.map((m) => makePill(m.name, m, { msId: m.id, date: m.targetDate })),
  );
  updateScrollFade(view.summary);
}

/** Fade a scrollable strip's edges only where more content is hidden, so a cut-off pill reads as "scroll for more". */
function updateScrollFade(strip) {
  const more = strip.scrollWidth - strip.clientWidth > 2;
  strip.classList.toggle("fade-l", more && strip.scrollLeft > 2);
  strip.classList.toggle("fade-r", more && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 2);
}

function drawNotes() {
  const parts = [];
  const ready = graph.nodes.filter((node) => node.ready);

  $("ready-pop")?.remove();
  if (ready.length > 0) {
    const wrap = el("div", { class: "ready-wrap" });
    const btn = el("button", { class: "tool-btn", type: "button", text: `Ready (${ready.length}) ▾` });
    // The list lives on <body>, not in the toolbar: the toolbar scrolls sideways and fades its edges,
    // and either would clip anything inside it.
    const pop = el("div", { id: "ready-pop", hidden: true });
    document.body.append(pop);
    for (const node of ready) {
      const row = el("button", { class: "ready-row", type: "button" }, [
        el("span", { class: "dot", style: `background:${milestoneColour(node.milestone)}` }),
        el("span", { class: "id mono", text: node.id }),
        el("span", { class: "ttl", text: node.title }),
      ]);
      row.addEventListener("click", (event) => {
        event.stopPropagation();
        pop.hidden = true;
        select(node.id, true);
      });
      pop.append(row);
    }
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      pop.hidden = !pop.hidden;
      if (pop.hidden) return;
      const r = btn.getBoundingClientRect();
      pop.style.top = `${r.bottom + 6}px`;
      if (window.innerWidth <= 720) Object.assign(pop.style, { left: "12px", right: "12px", width: "auto" });
      else Object.assign(pop.style, { left: `${Math.max(12, r.left)}px`, right: "auto", width: "" });
    });
    wrap.append(btn);
    parts.push(wrap);
  }

  const standaloneIds = graph.standalone ?? [];
  if (standaloneIds.length > 0) {
    const standaloneCount = standaloneIds.reduce((acc, id) => acc + (isGroup(id) ? groupById(id).members.length : 1), 0);
    const sortSelect = el(
      "select",
      { class: "tool-select", "aria-label": "Sort standalone issues", title: "Sort standalone issues (left to right)" },
      Object.entries(STANDALONE_SORTS).map(([key, label]) =>
        el("option", { value: key, selected: key === standaloneSort ? "selected" : null, text: `⇅ ${label}` }),
      ),
    );
    sortSelect.addEventListener("change", () => {
      sortSelect.blur();
      setStandaloneSort(sortSelect.value);
    });
    const hideBtn = el("button", {
      class: hideStandalone ? "tool-btn active" : "tool-btn",
      type: "button",
      text: hideStandalone ? `Show standalone (${standaloneCount})` : `Hide standalone (${standaloneCount})`,
    });
    hideBtn.addEventListener("click", toggleHideStandalone);
    const group = el("div", { class: "tool-group" }, hideStandalone ? [hideBtn] : [sortSelect, hideBtn]);
    parts.push(group);
  }

  for (const warning of graph.warnings) parts.push(el("span", { class: "warning", text: warning }));

  // The legend doubles as the switches: click a status to fold its issues into one dot.
  parts.push(
    el(
      "span",
      { class: "legend" },
      Object.entries(STATUSES).map(([status, name]) => {
        const off = collapsed.has(status);
        const count = graph.nodes.filter((node) => node.status === status).length;
        const toggle = el("button", {
          class: off ? "toggle off" : "toggle",
          type: "button",
          style: `--swatch:var(--${status})`,
          "aria-pressed": String(!off),
          title: off ? `${name}: folded into a dot. Click to show the cards.` : `${name}: click to fold these into a dot.`,
          text: `${name} ${count}`,
        });
        toggle.addEventListener("click", () => toggleCollapsed(status));
        return toggle;
      }),
    ),
  );
  view.notes.replaceChildren(...parts);
  updateScrollFade(view.notes);
}

/** Everything the selected issue waits on, and everything that waits on it. */
function chainOf(id) {
  const walk = (next) => {
    const found = new Set([id]);
    const queue = [id];
    while (queue.length) {
      for (const other of next(byId(queue.pop()))) {
        if (!found.has(other)) {
          found.add(other);
          queue.push(other);
        }
      }
    }
    return found;
  };
  return { upstream: walk((node) => node.blockedBy), downstream: walk((node) => node.blocks) };
}

function drawGraph() {
  if (!graph) return;
  layout = computeLayout();
  world.width = layout.width;
  world.height = layout.height;
  view.canvas.style.width = `${world.width}px`;
  view.canvas.style.height = `${world.height}px`;
  view.edges.setAttribute("width", world.width);
  view.edges.setAttribute("height", world.height);

  // Zones & section headings
  const zoneEls = [];
  for (const heading of layout.headings) {
    zoneEls.push(
      el("div", { class: "section-heading", style: `left:${heading.x}px;top:${heading.y}px` }, [
        el("span", { text: heading.title }),
        el("span", { class: "sub", text: heading.sub }),
      ]),
    );
  }
  for (const z of layout.zones) {
    const box = el("div", {
      class: z.dashed ? "zone dashed" : "zone",
      style: `left:${z.x}px;top:${z.y}px;width:${z.w}px;height:${z.h}px`,
    });
    if (z.title) {
      box.append(
        el("div", { class: "zone-title" }, [
          ...(z.dot ? [el("span", { class: "dot", style: `background:${z.dot}` })] : []),
          el("span", { text: z.title }),
          ...(z.sub ? [el("span", { class: "sub", text: `· ${z.sub}` })] : []),
        ]),
      );
    }
    zoneEls.push(box);
  }
  view.zones.replaceChildren(...zoneEls);

  // The chain to light up: the selected issue's, even when that issue is folded into a dot.
  const chain = selected && !isGroup(selected) ? chainOf(selected) : null;
  const members = (id) => (isGroup(id) ? groupById(id).members : [id]);
  const inChain = (id, side) => chain !== null && members(id).some((member) => chain[side].has(member));
  const lit = (id) => inChain(id, "upstream") || inChain(id, "downstream");
  const litEdge = (edge) =>
    (inChain(edge.from, "upstream") && inChain(edge.to, "upstream")) || (inChain(edge.from, "downstream") && inChain(edge.to, "downstream"));
  const isSelected = (id) => selected !== null && (id === selected || (isGroup(id) && !isGroup(selected) && groupById(id).members.includes(selected)));
  const isDimmed = (id) => {
    if (!milestoneFilter || lit(id)) return false;
    return !members(id).some((member) => byId(member)?.milestone === milestoneFilter);
  };

  view.edges.classList.toggle("focused", !!chain);
  view.cards.classList.toggle("focused", !!chain);

  // Lines first, lit ones last so they sit on top.
  const lines = graph.edges
    .filter((edge) => layout.placed.has(edge.from) && layout.placed.has(edge.to))
    .map((edge) => {
      const classes = ["edge"];
      if (edge.cyclic) classes.push("cyclic");
      else if (thing(edge.from).status === "done") classes.push("met");
      if (edge.via) classes.push("via");
      if (litEdge(edge)) classes.push("lit");
      const group = svg("g", { class: classes.join(" ") });
      const { path, head } = route(edge);
      group.append(svg("path", { class: "line", d: path }), svg("path", { class: "head", d: head }));
      return group;
    });
  lines.sort((a, b) => Number(a.classList.contains("lit")) - Number(b.classList.contains("lit")));
  view.edges.replaceChildren(...lines);

  const moved = drawItems(lit, isSelected, isDimmed);
  if (moved) view.edges.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: MOVE_MS * 1.5 });

  drawMinimap();
  if (fitted || refitNext) fit(drawn.size > 0 && (moved || refitNext));
  else applyViewport();
  refitNext = false;
}

/**
 * Put every visible card and dot in its place, animating moves smoothly.
 */
function drawItems(lit, isSelected, isDimmed) {
  const first = drawn.size === 0;
  const before = new Map([...drawn].map(([id, entry]) => [id, entry.place]));
  const keep = new Set();
  let moved = false;

  const show = (id, element, place, classes) => {
    element.className = classes.join(" ");
    element.style.left = `${place.left}px`;
    element.style.top = `${place.top}px`;
    element.style.width = `${place.width}px`;
    element.style.height = `${place.height}px`;
    keep.add(id);
    const was = before.get(id);
    if (!drawn.has(id)) view.cards.append(element);
    drawn.set(id, { element, place });
    if (first) return;
    if (was) {
      const dx = was.left - place.left;
      const dy = was.top - place.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        moved = true;
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: "ease" });
      }
    } else {
      moved = true;
      const from = isGroup(id) ? null : before.get(`group:${byId(id).status}`);
      const start = from
        ? { transform: `translate(${from.left + from.width / 2 - place.cx}px, ${from.top + from.height / 2 - place.cy}px) scale(0.1)`, opacity: 0 }
        : { transform: "scale(0.6)", opacity: 0 };
      element.animate([start, { transform: "none", opacity: 1 }], { duration: MOVE_MS, easing: "ease" });
    }
  };

  for (const node of graph.nodes) {
    if (node.collapsed) continue;
    const place = layout.placed.get(node.id);
    if (!place) continue;
    const classes = ["card", node.status];
    if (isSelected(node.id)) classes.push("selected");
    if (lit(node.id)) classes.push("lit");
    if (isDimmed(node.id)) classes.push("dimmed");
    const element = drawn.get(node.id)?.element ?? newButton(node.id);
    const due = node.dueDate
      ? el("span", { class: !node.done && isPast(node.dueDate) ? "due overdue" : "due", text: shortDay(node.dueDate) })
      : el("span", { class: "due" });
    const footerLabel = node.assignee ?? milestoneName(node.milestone);
    element.replaceChildren(
      el("span", { class: "top" }, [el("span", { class: "id mono", text: node.id }), el("span", { class: "state", text: statusText(node) })]),
      el("span", { class: "title", text: node.title }),
      el("span", { class: "bottom" }, [
        el("span", { class: "who" }, [el("span", { class: "dot", style: `background:${milestoneColour(node.milestone)}` }), footerLabel]),
        due,
      ]),
    );
    element.removeAttribute("title");
    show(node.id, element, place, classes);
  }

  for (const group of graph.groups) {
    const place = layout.placed.get(group.id);
    if (!place) continue;
    const classes = ["pin", group.status];
    if (isSelected(group.id)) classes.push("selected");
    if (lit(group.id)) classes.push("lit");
    if (isDimmed(group.id)) classes.push("dimmed");
    const element = drawn.get(group.id)?.element ?? newButton(group.id);
    const name = STATUSES[group.status].toLowerCase();
    element.textContent = String(group.members.length);
    element.title = `${group.members.length} ${name} issue${group.members.length === 1 ? "" : "s"}, folded. Click to list them.`;
    show(group.id, element, place, classes);
  }

  for (const [id, entry] of drawn) {
    if (keep.has(id)) continue;
    drawn.delete(id);
    moved = true;
    const node = isGroup(id) ? null : byId(id);
    const into = node?.collapsed ? drawn.get(`group:${node.status}`)?.place : null;
    const end = into
      ? { transform: `translate(${into.cx - entry.place.cx}px, ${into.cy - entry.place.cy}px) scale(0.1)`, opacity: 0 }
      : { transform: "scale(0.6)", opacity: 0 };
    entry.element.style.pointerEvents = "none";
    entry.element.animate([{ transform: "none", opacity: 1 }, end], { duration: MOVE_MS, easing: "ease", fill: "forwards" }).finished.then(
      () => entry.element.remove(),
      () => entry.element.remove(),
    );
  }
  return moved && !first;
}

function newButton(id) {
  const button = el("button", { type: "button", "data-id": id });
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    select(id === selected ? null : id);
  });
  return button;
}

/** The SVG path of one edge inside its cluster, and the arrowhead at its end. */
function route(edge) {
  const points = edge.points;
  const last = points.length - 1;
  const backwards = points[last][0] <= points[0][0];
  const source = layout.placed.get(edge.from);
  const target = layout.placed.get(edge.to);
  const meta = layout.clusterMeta.get(edge.cluster);
  const alongOffset = flow === "down" ? meta.oy : meta.ox;
  const acrossOffset = flow === "down" ? meta.ox : meta.oy;

  let fromAlong = source.leave;
  let fromAcross = source.mid;
  let path = `M${point(fromAlong, fromAcross)}`;
  for (let index = 1; index <= last; index++) {
    const rank = meta.ranks[points[index][0]];
    const toAlong = index === last ? target.enter : alongOffset + rank.start;
    const toAcross = index === last ? target.mid : acrossOffset + acrossMid(points[index][1]);
    const bend = backwards ? 120 : (toAlong - fromAlong) / 2;
    path += ` C${point(fromAlong + bend, fromAcross)} ${point(toAlong - bend, toAcross)} ${point(toAlong, toAcross)}`;
    if (index < last) {
      fromAlong = alongOffset + rank.start + rank.size;
      fromAcross = toAcross;
      path += ` L${point(fromAlong, fromAcross)}`;
    }
  }
  const tip = `M${point(target.enter, target.mid)}`;
  return { path, head: flow === "down" ? `${tip} l-4.5,-8 h9 z` : `${tip} l-8,-4.5 v9 z` };
}

// --- Moving around -----------------------------------------------------------

function applyViewport(animate = false) {
  view.canvas.classList.toggle("gliding", animate);
  view.canvas.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`;
  const dots = 24 * viewport.k * (viewport.k < 0.5 ? 2 : 1);
  view.stage.style.backgroundSize = `${dots}px ${dots}px`;
  view.stage.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
  drawMapView();
}

function zoomAt(x, y, scale, animate = false) {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
  viewport.x = x - ((x - viewport.x) / viewport.k) * k;
  viewport.y = y - ((y - viewport.y) / viewport.k) * k;
  viewport.k = k;
  fitted = false;
  applyViewport(animate);
}

function zoomAtCentre(factor) {
  zoomAt(view.stage.clientWidth / 2, view.stage.clientHeight / 2, viewport.k * factor, true);
}

/** The zoom buttons and the small map, as boxes in stage coordinates (with a little breathing room). */
function overlayBoxes() {
  const stage = view.stage.getBoundingClientRect();
  const boxes = [];
  for (const part of [document.querySelector(".controls"), view.minimap]) {
    if (!part || getComputedStyle(part).display === "none") continue;
    const r = part.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    boxes.push({ l: r.left - stage.left - 10, t: r.top - stage.top - 10, r: r.right - stage.left + 10, b: r.bottom - stage.top + 10 });
  }
  return boxes;
}

/**
 * Show the whole graph, as large as fits (never larger than full size), without letting the
 * zoom buttons or the small map sit on top of any of it.
 */
function fit(animate = true) {
  const width = view.stage.clientWidth;
  const height = view.stage.clientHeight;
  if (!world.width || !width || !height) return;
  const place = (l, t, w, h) => {
    const k = Math.max(MIN_ZOOM, Math.min(1, (w - FIT_MARGIN) / world.width, (h - FIT_MARGIN) / world.height));
    const x = l + (w - world.width * k) / 2;
    const y = t + Math.min(48, Math.max(12, (h - world.height * k) / 2));
    return { k, x, y };
  };
  const covers = (v, boxes) =>
    boxes.some((o) => v.x < o.r && o.l < v.x + world.width * v.k && v.y < o.b && o.t < v.y + world.height * v.k);
  const overlays = overlayBoxes();
  let best = place(0, 0, width, height);
  if (covers(best, overlays)) {
    // Either keep clear of the overlays' band along the bottom, or of their columns at the sides.
    const top = Math.min(...overlays.map((o) => o.t));
    const left = Math.max(0, ...overlays.filter((o) => o.l < width / 2).map((o) => o.r));
    const right = Math.min(width, ...overlays.filter((o) => o.l >= width / 2).map((o) => o.l));
    const options = [place(0, 0, width, top), place(left, 0, right - left, height)].filter((v) => !covers(v, overlays));
    if (options.length) best = options.reduce((a, b) => (b.k > a.k ? b : a));
  }
  Object.assign(viewport, best);
  fitted = true;
  applyViewport(animate);
}

function centreOn(id) {
  const targetId = drawnIdOf(id);
  const place = layout?.placed.get(targetId);
  if (!place) return;
  viewport.k = Math.max(viewport.k, window.innerWidth <= 720 ? 0.78 : 0.85);
  viewport.x = view.stage.clientWidth / 2 - place.cx * viewport.k;
  const verticalBias = window.innerWidth <= 720 && !view.detail.hidden ? 0.3 : 0.5;
  viewport.y = view.stage.clientHeight * verticalBias - place.cy * viewport.k;
  fitted = false;
  applyViewport(true);
}

function drawMinimap() {
  const visibleCount = layout?.placed.size ?? 0;
  view.minimap.style.display = visibleCount ? "" : "none";
  if (!visibleCount) return;
  const scale = Math.min(MAP_W / world.width, MAP_H / world.height);
  view.minimap.setAttribute("viewBox", `0 0 ${world.width} ${world.height}`);
  view.minimap.setAttribute("width", Math.max(40, world.width * scale));
  view.minimap.setAttribute("height", Math.max(30, world.height * scale));
  view.mapNodes.replaceChildren(
    ...[...layout.placed.entries()].map(([id, place]) => {
      const item = thing(id);
      const dot = isGroup(id);
      // A dot is drawn larger than life on the map so it does not vanish, but in proportion to the sheet.
      const grow = dot ? Math.min(14, Math.max(world.width, world.height) * 0.02) : 0;
      return svg("rect", {
        class: `${item.status}${id === selected ? " selected" : ""}`,
        x: place.left - grow,
        y: place.top - grow,
        width: place.width + grow * 2,
        height: place.height + grow * 2,
        rx: dot ? DOT_R + grow : 14,
      });
    }),
  );
}

function drawMapView() {
  view.mapView.setAttribute("x", -viewport.x / viewport.k);
  view.mapView.setAttribute("y", -viewport.y / viewport.k);
  view.mapView.setAttribute("width", view.stage.clientWidth / viewport.k);
  view.mapView.setAttribute("height", view.stage.clientHeight / viewport.k);
}

// --- The side panel / mobile bottom sheet -----------------------------------

function issueLink(id) {
  const other = byId(id);
  const link = el("button", { class: "link", type: "button" }, [
    el("span", { class: "dot", style: `background:var(--${other.status})` }),
    el("span", { class: "id mono", text: other.id }),
    el("span", { text: other.title }),
  ]);
  link.addEventListener("click", () => select(id, true));
  return link;
}

function issueLinks(ids) {
  return ids.length === 0 ? [el("div", { class: "none", text: "Nothing" })] : ids.map(issueLink);
}

function drawDetail() {
  const item = selected && thing(selected);
  view.detail.hidden = !item;
  if (!item) {
    view.detail.replaceChildren();
    return;
  }
  const close = el("button", { class: "close", type: "button", title: "Close", text: "×" });
  close.addEventListener("click", () => select(null));

  if (isGroup(selected)) {
    const name = STATUSES[item.status];
    const unfold = el("button", { class: "action", type: "button", text: "Show these as cards" });
    unfold.addEventListener("click", () => toggleCollapsed(item.status));
    view.detail.replaceChildren(
      close,
      el("div", { class: "id", text: "Folded into one dot" }),
      el("h2", { text: `${item.members.length} ${name.toLowerCase()} issue${item.members.length === 1 ? "" : "s"}` }),
      unfold,
      el("h3", { text: name }),
      ...issueLinks(item.members),
    );
    return;
  }

  const milestone = graph.milestones.find((entry) => entry.id === item.milestone);
  const rows = [
    ["Status", statusText(item) === item.state.name ? item.state.name : `${item.state.name} · ${statusText(item)}`],
    ["Owner", item.assignee ?? "Unassigned"],
    ["Due", item.dueDate ? shortDay(item.dueDate) + (!item.done && isPast(item.dueDate) ? " (overdue)" : "") : "No date"],
    ["Milestone", milestone ? milestone.name : "None"],
    ["Priority", PRIORITIES[item.priority] ?? "None"],
  ];
  const list = el("dl");
  for (const [name, value] of rows) list.append(el("dt", { text: name }), el("dd", { text: value }));

  const parts = [close, el("div", { class: "id mono", text: item.id }), el("h2", { text: item.title })];
  if (item.url.startsWith("https://linear.app/")) {
    parts.push(el("a", { href: item.url, target: "_blank", rel: "noopener noreferrer", text: "Open in Linear ↗" }));
  }
  if (item.collapsed) parts.push(el("div", { class: "folded", text: `Folded into the ${STATUSES[item.status].toLowerCase()} dot.` }));
  parts.push(
    list,
    el("h3", { text: `Blocked by (${item.blockedBy.length})` }),
    ...issueLinks(item.blockedBy),
    el("h3", { text: `Blocks (${item.blocks.length})` }),
    ...issueLinks(item.blocks),
  );
  view.detail.replaceChildren(...parts);
}

function select(id, scroll = false) {
  selected = id;
  // If user picks a standalone issue while standalone is hidden, reveal it so it can be seen & centred.
  if (id && hideStandalone && graph && !layout?.placed.has(drawnIdOf(id))) {
    hideStandalone = false;
    store(HIDE_STANDALONE_KEY, false);
    drawNotes();
  }
  syncUrl(false);
  drawGraph();
  drawDetail();
  if (id && scroll) centreOn(id);
  else if (id) keepAboveSheet(id);
}

/** On a phone the detail panel is a sheet over the bottom of the graph; slide the chosen card up out from under it. */
function keepAboveSheet(id) {
  if (window.innerWidth > 720 || view.detail.hidden) return;
  const card = drawn.get(drawnIdOf(id))?.element;
  if (!card) return;
  const c = card.getBoundingClientRect();
  const sheetTop = view.detail.getBoundingClientRect().top;
  const stageTop = view.stage.getBoundingClientRect().top;
  if (c.bottom <= sheetTop - 8 && c.top >= stageTop) return;
  viewport.y += (stageTop + sheetTop) / 2 - (c.top + c.bottom) / 2;
  fitted = false;
  applyViewport(true);
}

// --- Wiring (mouse + multi-touch pinch/pan) --------------------------------

view.project.addEventListener("change", () => {
  view.project.blur();
  switchProject(view.project.value);
});
window.addEventListener("popstate", () => {
  const fromUrl = new URLSearchParams(location.search).get("project") ?? projects[0]?.id ?? null;
  const fromHash = decodeURIComponent(location.hash.slice(1)) || null;
  if (fromUrl && fromUrl !== activeProject && projects.some((entry) => entry.id === fromUrl)) {
    switchProject(fromUrl, { push: false, nextSelected: fromHash });
  } else if (graph && fromHash !== selected) {
    selected = fromHash && thing(fromHash) ? fromHash : null;
    drawGraph();
    drawDetail();
  }
});
view.refresh.addEventListener("click", async () => {
  view.refresh.disabled = true;
  await load(true);
  view.refresh.disabled = false;
});
view.zoomIn.addEventListener("click", () => zoomAtCentre(ZOOM_STEP));
view.zoomOut.addEventListener("click", () => zoomAtCentre(1 / ZOOM_STEP));
view.zoomFit.addEventListener("click", () => fit());
view.flow.addEventListener("click", toggleFlow);

for (const strip of [view.summary, view.notes]) strip.addEventListener("scroll", () => updateScrollFade(strip), { passive: true });

// Close the Ready popover on outside click.
document.addEventListener("click", () => {
  const pop = $("ready-pop");
  if (pop) pop.hidden = true;
});

// Unified single-pointer pan + two-finger pinch-zoom/pan.
const pointers = new Map();
let drag = null;
let pinch = null;
let justDragged = false;
let lastTap = { time: 0, x: 0, y: 0 };

function pinchMetrics() {
  const [a, b] = [...pointers.values()];
  const frame = view.stage.getBoundingClientRect();
  return {
    dist: Math.hypot(b.x - a.x, b.y - a.y) || 1,
    mx: (a.x + b.x) / 2 - frame.left,
    my: (a.y + b.y) / 2 - frame.top,
  };
}

view.stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".controls, #minimap")) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    drag = { pointer: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: viewport.x, y: viewport.y, moving: false };
    pinch = null;
  } else if (pointers.size === 2) {
    drag = null;
    justDragged = true;
    const m = pinchMetrics();
    pinch = { dist: m.dist, mx: m.mx, my: m.my, x: viewport.x, y: viewport.y, k: viewport.k };
    view.stage.classList.add("dragging");
    for (const pid of pointers.keys()) {
      try {
        view.stage.setPointerCapture(pid);
      } catch {
        // Ignore capture refusal.
      }
    }
  }
});

view.stage.addEventListener("pointermove", (event) => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

  if (pinch && pointers.size >= 2) {
    const m = pinchMetrics();
    const nextK = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.k * (m.dist / pinch.dist)));
    const worldX = (pinch.mx - pinch.x) / pinch.k;
    const worldY = (pinch.my - pinch.y) / pinch.k;
    viewport.k = nextK;
    viewport.x = m.mx - worldX * nextK;
    viewport.y = m.my - worldY * nextK;
    fitted = false;
    applyViewport(false);
    return;
  }

  if (!drag || event.pointerId !== drag.pointer) return;
  const dx = event.clientX - drag.fromX;
  const dy = event.clientY - drag.fromY;
  if (!drag.moving) {
    if (Math.hypot(dx, dy) < DRAG_START) return;
    drag.moving = true;
    view.stage.setPointerCapture(event.pointerId);
    view.stage.classList.add("dragging");
  }
  viewport.x = drag.x + dx;
  viewport.y = drag.y + dy;
  fitted = false;
  applyViewport();
});

for (const type of ["pointerup", "pointercancel"]) {
  view.stage.addEventListener(type, (event) => {
    if (!pointers.has(event.pointerId)) return;
    const wasPinch = pinch !== null;
    const wasMoving = Boolean(drag?.moving);
    pointers.delete(event.pointerId);

    if (pointers.size === 1 && wasPinch) {
      // Seamlessly hand off remaining finger to pan without jumping.
      pinch = null;
      const [pid, pt] = [...pointers.entries()][0];
      drag = { pointer: pid, fromX: pt.x, fromY: pt.y, x: viewport.x, y: viewport.y, moving: true };
      return;
    }

    if (pointers.size === 0) {
      if (wasMoving || wasPinch) {
        view.stage.classList.remove("dragging");
        justDragged = true;
        setTimeout(() => (justDragged = false), 50);
      } else if (event.pointerType === "touch" && !event.target.closest(".card, .pin, .controls, #minimap")) {
        // Double-tap empty space on touch devices zooms in or resets to Fit.
        const nowTs = Date.now();
        if (nowTs - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 36) {
          lastTap.time = 0;
          if (viewport.k >= 1.15) fit(true);
          else {
            const frame = view.stage.getBoundingClientRect();
            zoomAt(event.clientX - frame.left, event.clientY - frame.top, Math.max(viewport.k * 1.7, 0.9), true);
          }
        } else {
          lastTap = { time: nowTs, x: event.clientX, y: event.clientY };
        }
      }
      drag = null;
      pinch = null;
    }
  });
}

// touch-action alone does not stop every browser (iOS Safari in particular) from zooming the whole
// page on a pinch, so cancel the browser's own handling of moves and gestures on the graph. Taps
// are left alone so cards stay clickable; pointer events still arrive for our own pan and zoom.
view.stage.addEventListener("touchmove", (event) => event.preventDefault(), { passive: false });
for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
  view.stage.addEventListener(type, (event) => event.preventDefault(), { passive: false });
}

view.stage.addEventListener(
  "click",
  (event) => {
    if (justDragged) {
      event.stopPropagation();
      event.preventDefault();
    }
  },
  true,
);

// Scroll or trackpad pinch to zoom toward the pointer.
view.stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const frame = view.stage.getBoundingClientRect();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    const factor = Math.exp(-amount * (event.ctrlKey ? 0.01 : 0.0018));
    zoomAt(event.clientX - frame.left, event.clientY - frame.top, viewport.k * factor);
  },
  { passive: false },
);
view.stage.addEventListener("dblclick", (event) => {
  if (event.target.closest(".card, .pin, .controls, #minimap")) return;
  const frame = view.stage.getBoundingClientRect();
  if (viewport.k >= 1.2) fit(true);
  else zoomAt(event.clientX - frame.left, event.clientY - frame.top, viewport.k * 1.6, true);
});

// Click or drag on the small map to look at that part of the graph.
let mapDrag = false;
const lookAt = (event) => {
  const frame = view.minimap.getBoundingClientRect();
  const x = ((event.clientX - frame.left) / frame.width) * world.width;
  const y = ((event.clientY - frame.top) / frame.height) * world.height;
  viewport.x = view.stage.clientWidth / 2 - x * viewport.k;
  viewport.y = view.stage.clientHeight / 2 - y * viewport.k;
  fitted = false;
  applyViewport();
};
view.minimap.addEventListener("pointerdown", (event) => {
  mapDrag = true;
  view.minimap.setPointerCapture(event.pointerId);
  lookAt(event);
});
view.minimap.addEventListener("pointermove", (event) => mapDrag && lookAt(event));
for (const type of ["pointerup", "pointercancel"]) view.minimap.addEventListener(type, () => (mapDrag = false));
for (const part of [view.minimap, document.querySelector(".controls")]) {
  part.addEventListener("click", (event) => event.stopPropagation());
  part.addEventListener("dblclick", (event) => event.stopPropagation());
}

// Re-pack clusters and standalone grid when the viewport width/orientation changes meaningfully.
let lastLayoutWidth = 0;
new ResizeObserver(() => {
  if (!graph) return;
  showSync();
  updateScrollFade(view.summary);
  updateScrollFade(view.notes);
  const w = view.stage.clientWidth;
  if (w > 0 && Math.abs(w - lastLayoutWidth) > 80) {
    lastLayoutWidth = w;
    drawGraph();
  } else if (fitted) {
    fit(false);
  } else {
    drawMapView();
  }
}).observe(view.stage);

view.stage.addEventListener("click", () => selected && select(null));
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("input, select, textarea")) return;
  if (event.key === "Escape" && selected) select(null);
  else if (event.key === "+" || event.key === "=") zoomAtCentre(ZOOM_STEP);
  else if (event.key === "-") zoomAtCentre(1 / ZOOM_STEP);
  else if (event.key === "0" || event.key === "f") fit();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
setInterval(() => {
  if (!document.hidden) load();
}, POLL_MS);
setInterval(showSync, 30_000);

init();
