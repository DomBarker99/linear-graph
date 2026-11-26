// The page. Asks the server for the graph (GET /api/graph) and draws it:
// cards are HTML, the lines between them are one SVG underneath.
// The server has already decided each card's rank (how far along the flow) and
// its place across it; this file only turns those into pixels. Everything from
// Linear is put on the page as text, never as HTML.
//
// The graph is one sheet that can be dragged around and zoomed, with a small
// map of the whole thing in the corner. The lines run down the page, or left to
// right. Each status in the legend can be collapsed, which folds its issues
// into a single dot.

const CARD_W = 232;
const CARD_H = 90;
const PAD = 24;
// Pixels for one unit of the server's "across". A card takes one unit, so this is its size plus breathing room.
const UNIT = { down: CARD_W + 12, right: CARD_H + 10 };
// Room between two ranks, where the lines bend.
const RANK_GAP = { down: 58, right: 64 };
const DOT_RANK = 44; // size along the flow of a rank that holds only dots
const DOT_R = 15; // radius of the dot a collapsed status folds into
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.3; // one press of + or −
const FIT_MARGIN = 40; // room left around the graph when it is fitted to the window
const DRAG_START = 4; // how far the pointer must move before a press counts as a drag
const MAP_W = 210;
const MAP_H = 150;
const MOVE_MS = 300; // how long cards take to slide to a new place
const POLL_MS = 60_000;

const MILESTONE_COLOURS = ["#7c9cff", "#c58af9", "#4fc3c8", "#f28b82", "#d4c15a", "#8bc34a", "#ff9e64", "#90a4ae"];
const PRIORITIES = ["None", "Urgent", "High", "Medium", "Low"];
const STATUSES = { ready: "Ready", started: "In progress", blocked: "Blocked", done: "Done" };
const COLLAPSED_KEY = "linear-graph.collapsed";
const FLOW_KEY = "linear-graph.flow";
const PROJECT_KEY = "linear-graph.project";
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
// All configured projects from /api/projects, and which one is open.
let projects = [];
let activeProject = new URLSearchParams(location.search).get("project") || null;
let loadSeq = 0;
// What is selected: an issue ("CS1-14") or a collapsed status's dot ("group:done").
// Kept in the address (#CS1-14), so a link opens on the same thing.
let selected = decodeURIComponent(location.hash.slice(1)) || null;
// Where the sheet sits: x, y is its top-left corner inside the stage, k is the scale (1 = full size).
const viewport = { x: 0, y: 0, k: 1 };
// True until the sheet is moved or zoomed by hand. While true, it is re-fitted when the window changes.
let fitted = true;
// Set when the layout was changed on purpose (collapse, flow): the next draw frames the new graph.
let refitNext = false;
// Size of the whole sheet at full size.
const world = { width: 0, height: 0 };
// Where each rank starts along the flow and how much room it takes.
let ranks = [];
// Every card and dot on the sheet, by id, so a redraw can slide them instead of replacing them.
const drawn = new Map();
// The statuses folded into dots, and which way the lines run. Remembered in this browser.
const collapsed = new Set(stored(COLLAPSED_KEY, []).filter((status) => status in STATUSES));
let flow = stored(FLOW_KEY, "down") === "right" ? "right" : "down";

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

// --- Dates -----------------------------------------------------------------

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

function ago(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `at ${new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

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
  graph = null;
  drawn.clear();
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
    // The server lays the graph out, so it has to know which project, what is collapsed, and which way the lines run.
    const query = new URLSearchParams();
    if (activeProject) query.set("project", activeProject);
    if (collapsed.size) query.set("collapse", [...collapsed].join(","));
    if (flow === "right") query.set("flow", "right");
    const response = await fetch(`${refresh ? "/api/refresh" : "/api/graph"}?${query}`, { method: refresh ? "POST" : "GET" });
    const body = await response.json();
    if (seq !== loadSeq) return;
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    if (Array.isArray(body.projects) && JSON.stringify(body.projects) !== JSON.stringify(projects)) {
      projects = body.projects;
      drawProjects();
    }
    if (body.project?.id) activeProject = body.project.id;
    graph = body;
    if (selected && !thing(selected)) selected = null;
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
  if (graph.syncError) {
    view.sync.textContent = `Linear could not be read (${graph.syncError}). Showing what was read ${ago(graph.lastSync)}.`;
    view.sync.className = "failing";
  } else {
    view.sync.textContent = `Read from Linear ${ago(graph.lastSync)}`;
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
function drawnAs(id) {
  if (isGroup(id)) return groupById(id);
  const node = byId(id);
  return node.collapsed ? groupById(`group:${node.status}`) : node;
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

function milestoneColour(id) {
  const index = graph.milestones.findIndex((milestone) => milestone.id === id);
  return MILESTONE_COLOURS[index % MILESTONE_COLOURS.length];
}

// --- Geometry: from rank and across to pixels --------------------------------
// "Along" is the direction the lines run (down the page, or to the right);
// "across" is the other one. Everything is worked out in those two and turned
// into x and y at the last step, so both flows share one set of rules.

const point = (along, across) => (flow === "down" ? [across, along] : [along, across]);
const cardAlong = () => (flow === "down" ? CARD_H : CARD_W);
const cardAcross = () => (flow === "down" ? CARD_W : CARD_H);
/** The centre line, across the flow, of something the server placed at `across`. */
const acrossMid = (across) => PAD + across * UNIT[flow] + cardAcross() / 2;

/** Work out where each rank sits along the flow. Returns the length of the sheet along it. */
function layoutRanks() {
  ranks = [];
  let start = PAD;
  for (let rank = 0; rank < graph.ranks; rank++) {
    const hasCard = graph.nodes.some((node) => node.rank === rank && !node.collapsed);
    const size = hasCard ? cardAlong() : DOT_RANK;
    ranks.push({ start, size });
    start += size + RANK_GAP[flow];
  }
  return Math.max(PAD * 2, start - RANK_GAP[flow] + PAD);
}

/**
 * Where a card or a dot is drawn. left/top/width/height are its box, cx/cy its centre,
 * and enter/leave are how far along the flow its lines arrive and depart.
 */
function box(item) {
  const rank = ranks[item.rank];
  const mid = acrossMid(item.across);
  const dot = "members" in item;
  const along = dot ? rank.start + rank.size / 2 - DOT_R : rank.start;
  const length = dot ? DOT_R * 2 : cardAlong();
  const breadth = dot ? DOT_R * 2 : cardAcross();
  const [left, top] = point(along, mid - breadth / 2);
  const [width, height] = point(length, breadth);
  return { left, top, width, height, cx: left + width / 2, cy: top + height / 2, mid, enter: along, leave: along + length };
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

function meter(name, counts, extra = {}) {
  const percent = (value) => `${counts.total ? (value / counts.total) * 100 : 0}%`;
  const label = el("span", { class: "name" });
  if (extra.colour) label.append(el("span", { class: "dot", style: `background:${extra.colour}` }));
  label.append(name);
  if (extra.date) {
    const late = isPast(extra.date) && counts.done < counts.total;
    label.append(el("span", { class: late ? "date overdue" : "date", text: `  ${shortDay(extra.date)}` }));
  }
  return el("div", { class: extra.overall ? "meter overall" : "meter" }, [
    el("div", { class: "label" }, [label, el("span", { class: "count", text: `${counts.done} / ${counts.total} done` })]),
    el("div", { class: "bar", title: `${counts.done} done, ${counts.started} in progress, ${counts.total} total` }, [
      el("div", { class: "done", style: `width:${percent(counts.done)}` }),
      el("div", { class: "started", style: `width:${percent(counts.started)}` }),
    ]),
  ]);
}

function drawSummary() {
  view.summary.replaceChildren(
    meter("All issues", graph.totals, { overall: true }),
    ...graph.milestones.map((milestone) =>
      meter(milestone.name, milestone, { colour: milestoneColour(milestone.id), date: milestone.targetDate }),
    ),
  );
}

function drawNotes() {
  const ready = graph.nodes.filter((node) => node.ready);
  const parts = [];
  if (ready.length) {
    parts.push(el("span", { text: "Ready to start:" }));
    for (const node of ready) {
      const chip = el("button", { class: "chip mono", type: "button", text: node.id, title: node.title });
      chip.addEventListener("click", () => select(node.id, true));
      parts.push(chip);
    }
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
  const along = layoutRanks();
  const across = PAD * 2 + Math.max(0, graph.breadth - 1) * UNIT[flow] + cardAcross();
  const [width, height] = point(along, across);
  view.canvas.style.width = `${width}px`;
  view.canvas.style.height = `${height}px`;
  view.edges.setAttribute("width", width);
  view.edges.setAttribute("height", height);
  world.width = width;
  world.height = height;

  // The chain to light up: the selected issue's, even when that issue is folded into a dot.
  const chain = selected && !isGroup(selected) ? chainOf(selected) : null;
  const members = (id) => (isGroup(id) ? groupById(id).members : [id]);
  const inChain = (id, side) => chain !== null && members(id).some((member) => chain[side].has(member));
  const lit = (id) => inChain(id, "upstream") || inChain(id, "downstream");
  const litEdge = (edge) =>
    (inChain(edge.from, "upstream") && inChain(edge.to, "upstream")) || (inChain(edge.from, "downstream") && inChain(edge.to, "downstream"));
  const isSelected = (id) => selected !== null && (id === selected || (isGroup(id) && !isGroup(selected) && groupById(id).members.includes(selected)));

  view.edges.classList.toggle("focused", !!chain);
  view.cards.classList.toggle("focused", !!chain);

  // Lines first, lit ones last so they sit on top.
  const lines = graph.edges.map((edge) => {
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

  const moved = drawItems(lit, isSelected);
  // When things moved, the lines wait for them to arrive and then fade in.
  if (moved) view.edges.animate([{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }], { duration: MOVE_MS * 1.5 });

  drawMinimap();
  if (fitted || refitNext) fit(drawn.size > 0 && (moved || refitNext));
  else applyViewport();
  refitNext = false;
}

/**
 * Put every card and dot in its place. Elements are kept from one draw to the
 * next, so a card that moves slides there, a card being folded shrinks into its
 * dot, and a card being unfolded grows out of it. Returns whether anything moved.
 */
function drawItems(lit, isSelected) {
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
      // Already on the sheet: slide from where it was.
      const dx = was.left - place.left;
      const dy = was.top - place.top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        moved = true;
        element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: MOVE_MS, easing: "ease" });
      }
    } else {
      // New on the sheet: grow out of the dot it was folded into, if there was one.
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
    const classes = ["card", node.status];
    if (isSelected(node.id)) classes.push("selected");
    if (lit(node.id)) classes.push("lit");
    const element = drawn.get(node.id)?.element ?? newButton(node.id);
    const due = node.dueDate
      ? el("span", { class: !node.done && isPast(node.dueDate) ? "due overdue" : "due", text: shortDay(node.dueDate) })
      : el("span", { class: "due" });
    element.replaceChildren(
      el("span", { class: "top" }, [el("span", { class: "id mono", text: node.id }), el("span", { class: "state", text: statusText(node) })]),
      el("span", { class: "title", text: node.title }),
      el("span", { class: "bottom" }, [
        el("span", { class: "who" }, [el("span", { class: "dot", style: `background:${milestoneColour(node.milestone)}` }), node.assignee ?? "Unassigned"]),
        due,
      ]),
    );
    element.removeAttribute("title");
    show(node.id, element, box(node), classes);
  }

  for (const group of graph.groups) {
    const classes = ["pin", group.status];
    if (isSelected(group.id)) classes.push("selected");
    if (lit(group.id)) classes.push("lit");
    const element = drawn.get(group.id)?.element ?? newButton(group.id);
    const name = STATUSES[group.status].toLowerCase();
    element.textContent = String(group.members.length);
    element.title = `${group.members.length} ${name} issue${group.members.length === 1 ? "" : "s"}, folded. Click to list them.`;
    show(group.id, element, box(group), classes);
  }

  // What is no longer drawn: a folded card shrinks into its dot, anything else fades.
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

/** The SVG path of one edge, and the arrowhead at its end. */
function route(edge) {
  const points = edge.points;
  const last = points.length - 1;
  const backwards = points[last][0] <= points[0][0]; // only a loop edge can point back
  const source = box(thing(edge.from));
  const target = box(thing(edge.to));
  let fromAlong = source.leave;
  let fromAcross = source.mid;
  let path = `M${point(fromAlong, fromAcross)}`;
  for (let index = 1; index <= last; index++) {
    const rank = ranks[points[index][0]];
    const toAlong = index === last ? target.enter : rank.start;
    const toAcross = index === last ? target.mid : acrossMid(points[index][1]);
    const bend = backwards ? 120 : (toAlong - fromAlong) / 2;
    path += ` C${point(fromAlong + bend, fromAcross)} ${point(toAlong - bend, toAcross)} ${point(toAlong, toAcross)}`;
    if (index < last) {
      // Straight through the rank the line is passing.
      fromAlong = rank.start + rank.size;
      fromAcross = toAcross;
      path += ` L${point(fromAlong, fromAcross)}`;
    }
  }
  const tip = `M${point(target.enter, target.mid)}`;
  return { path, head: flow === "down" ? `${tip} l-4.5,-8 h9 z` : `${tip} l-8,-4.5 v9 z` };
}

// --- Moving around -----------------------------------------------------------

/** Put the sheet where `viewport` says. animate = glide there instead of jumping. */
function applyViewport(animate = false) {
  view.canvas.classList.toggle("gliding", animate);
  view.canvas.style.transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`;
  // The dotted background moves and scales with the sheet, so dragging feels like moving paper.
  const dots = 24 * viewport.k * (viewport.k < 0.5 ? 2 : 1);
  view.stage.style.backgroundSize = `${dots}px ${dots}px`;
  view.stage.style.backgroundPosition = `${viewport.x}px ${viewport.y}px`;
  drawMapView();
}

/** Change the scale while keeping the point (x, y) of the stage where it is on screen. */
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

/** Show the whole graph, as large as fits (never larger than full size). */
function fit(animate = true) {
  const width = view.stage.clientWidth;
  const height = view.stage.clientHeight;
  if (!world.width || !width) return;
  const k = Math.min(1, (width - FIT_MARGIN) / world.width, (height - FIT_MARGIN) / world.height);
  viewport.k = Math.max(MIN_ZOOM, k);
  viewport.x = (width - world.width * viewport.k) / 2;
  viewport.y = Math.min(60, (height - world.height * viewport.k) / 2);
  fitted = true;
  applyViewport(animate);
}

/** Glide so that this issue's card, or the dot it is folded into, is in the middle of the stage. */
function centreOn(id) {
  const place = box(drawnAs(id));
  viewport.x = view.stage.clientWidth / 2 - place.cx * viewport.k;
  viewport.y = view.stage.clientHeight / 2 - place.cy * viewport.k;
  fitted = false;
  applyViewport(true);
}

/** The small map: one block per card, one blob per dot. Redrawn with the graph. */
function drawMinimap() {
  const scale = Math.min(MAP_W / world.width, MAP_H / world.height);
  view.minimap.setAttribute("viewBox", `0 0 ${world.width} ${world.height}`);
  view.minimap.setAttribute("width", world.width * scale);
  view.minimap.setAttribute("height", world.height * scale);
  view.minimap.style.display = graph.nodes.length ? "" : "none";
  const shown = [...graph.nodes.filter((node) => !node.collapsed), ...graph.groups];
  view.mapNodes.replaceChildren(
    ...shown.map((item) => {
      const place = box(item);
      const dot = "members" in item;
      // On the map a dot is drawn larger than life, or it would vanish.
      const grow = dot ? 14 : 0;
      return svg("rect", {
        class: `${item.status}${item.id === selected ? " selected" : ""}`,
        x: place.left - grow,
        y: place.top - grow,
        width: place.width + grow * 2,
        height: place.height + grow * 2,
        rx: dot ? DOT_R + grow : 14,
      });
    }),
  );
}

/** The frame on the small map that shows which part of the graph is on screen. */
function drawMapView() {
  view.mapView.setAttribute("x", -viewport.x / viewport.k);
  view.mapView.setAttribute("y", -viewport.y / viewport.k);
  view.mapView.setAttribute("width", view.stage.clientWidth / viewport.k);
  view.mapView.setAttribute("height", view.stage.clientHeight / viewport.k);
}

// --- The side panel ----------------------------------------------------------

/** A row that names another issue and selects it when clicked. */
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
    // A dot: what it stands for, and a way to bring the cards back.
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
  // Only ever link to Linear itself, whatever the data says.
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
  syncUrl(false);
  drawGraph();
  drawDetail();
  if (id && scroll) centreOn(id);
}

// --- Wiring ----------------------------------------------------------------

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

// Drag anywhere on the stage to move the sheet. A press that does not move is still a click,
// so cards stay clickable; the pointer is only taken over once it has moved a few pixels.
let drag = null;
let justDragged = false;
view.stage.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".controls, #minimap")) return;
  drag = { pointer: event.pointerId, fromX: event.clientX, fromY: event.clientY, x: viewport.x, y: viewport.y, moving: false };
});
view.stage.addEventListener("pointermove", (event) => {
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
    if (!drag || event.pointerId !== drag.pointer) return;
    if (drag.moving) {
      view.stage.classList.remove("dragging");
      // The click that ends a drag must not select a card or clear the selection.
      justDragged = true;
      setTimeout(() => (justDragged = false), 0);
    }
    drag = null;
  });
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

// Scroll or pinch to zoom toward the pointer.
view.stage.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const frame = view.stage.getBoundingClientRect();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    // A trackpad pinch arrives as a wheel event with ctrlKey set and small numbers.
    const factor = Math.exp(-amount * (event.ctrlKey ? 0.01 : 0.0018));
    zoomAt(event.clientX - frame.left, event.clientY - frame.top, viewport.k * factor);
  },
  { passive: false },
);
view.stage.addEventListener("dblclick", (event) => {
  if (event.target.closest(".card, .pin, .controls, #minimap")) return;
  const frame = view.stage.getBoundingClientRect();
  zoomAt(event.clientX - frame.left, event.clientY - frame.top, viewport.k * 1.6, true);
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

// Opening the side panel or resizing the window changes how much fits.
new ResizeObserver(() => (fitted ? fit(false) : drawMapView())).observe(view.stage);
view.stage.addEventListener("click", () => selected && select(null));
document.addEventListener("keydown", (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return; // leave the browser's own shortcuts alone
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
