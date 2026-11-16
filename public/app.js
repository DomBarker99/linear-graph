// The page. Asks the server for the graph (GET /api/graph) and draws it:
// cards are HTML, the lines between them are one SVG underneath.
// The graph is one sheet that can be dragged around and zoomed, with a small
// map of the whole thing in the corner. Each status in the legend can be
// collapsed, which draws its issues as dots instead of cards.
// The server has already decided each card's column and height; this file only
// turns those into pixels. Everything from Linear is put on the page as text,
// never as HTML.

const CARD_W = 232;
const CARD_H = 90;
const COL_GAP = 64; // room between two columns, where the lines bend
const DOT_COL = 40; // width of a column that holds only dots
const DOT_R = 9; // radius of a collapsed issue's dot
const ROW_PITCH = 100; // pixels per unit of the server's y
const PAD = 24;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2.5;
const ZOOM_STEP = 1.3; // one press of + or −
const FIT_MARGIN = 40; // room left around the graph when it is fitted to the window
const DRAG_START = 4; // how far the pointer must move before a press counts as a drag
const MAP_W = 210;
const MAP_H = 120;
const POLL_MS = 60_000;

const MILESTONE_COLOURS = ["#7c9cff", "#c58af9", "#4fc3c8", "#f28b82", "#d4c15a", "#8bc34a", "#ff9e64", "#90a4ae"];
const PRIORITIES = ["None", "Urgent", "High", "Medium", "Low"];
const STATUSES = { ready: "Ready", started: "In progress", blocked: "Blocked", done: "Done" };
const STORE_KEY = "linear-graph.collapsed";
const SVG = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const view = {
  title: $("title"),
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
  minimap: $("minimap"),
  mapNodes: $("map-nodes"),
  mapView: $("map-view"),
  edges: $("edges"),
  cards: $("cards"),
  detail: $("detail"),
};

let graph = null;
// The selected issue is kept in the address (#CS1-14), so a link opens on the same issue.
let selected = decodeURIComponent(location.hash.slice(1)) || null;
// Where the sheet sits: x, y is its top-left corner inside the stage, k is the scale (1 = full size).
const viewport = { x: 0, y: 0, k: 1 };
// True until the sheet is moved or zoomed by hand. While true, it is re-fitted when the window changes.
let fitted = true;
// Size of the whole sheet at full size.
const world = { width: 0, height: 0 };
// Where each column starts and how wide it is. A column with only dots in it is narrow.
let columns = [];
// The statuses drawn as dots. Remembered in this browser.
const collapsed = new Set(readCollapsed());

function readCollapsed() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]").filter((status) => status in STATUSES);
  } catch {
    return [];
  }
}

function toggleCollapsed(status) {
  if (!collapsed.delete(status)) collapsed.add(status);
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // Private windows may refuse; the choice then lasts until the page is closed.
  }
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

// --- Loading ---------------------------------------------------------------

async function load(refresh = false) {
  try {
    // The server lays the graph out, so it has to know which statuses are dots.
    const query = collapsed.size ? `?collapse=${[...collapsed].join(",")}` : "";
    const response = await fetch((refresh ? "/api/refresh" : "/api/graph") + query, { method: refresh ? "POST" : "GET" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    graph = body;
    if (selected && !graph.nodes.some((node) => node.id === selected)) selected = null;
    draw();
  } catch (error) {
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

// --- Drawing ---------------------------------------------------------------

const nodeTop = (y) => PAD + y * ROW_PITCH;
const nodeMid = (y) => nodeTop(y) + CARD_H / 2;

/** Work out where each column sits. Returns the width of the whole sheet. */
function layoutColumns() {
  columns = [];
  let x = PAD;
  for (let col = 0; col < graph.columns; col++) {
    const hasCard = graph.nodes.some((node) => node.col === col && !node.collapsed);
    const width = hasCard ? CARD_W : DOT_COL;
    columns.push({ x, width });
    x += width + COL_GAP;
  }
  return Math.max(PAD * 2, x - COL_GAP + PAD);
}

/** Where an issue is drawn: left and right are where its lines attach, cx and mid its centre. */
function box(node) {
  const column = columns[node.col];
  const cx = column.x + column.width / 2;
  const mid = nodeMid(node.y);
  return node.collapsed ? { left: cx - DOT_R, right: cx + DOT_R, cx, mid } : { left: column.x, right: column.x + column.width, cx, mid };
}

function statusClass(node) {
  return node.status;
}

function statusText(node) {
  if (node.done) return node.state.name;
  if (node.blocked) {
    const open = openBlockers(node).length;
    return node.state.type === "started" ? `${node.state.name} · blocked by ${open}` : `Blocked by ${open}`;
  }
  if (node.state.type === "started") return node.state.name;
  return node.ready ? "Ready to start" : node.state.name;
}

function byId(id) {
  return graph.nodes.find((node) => node.id === id);
}

function openBlockers(node) {
  return node.blockedBy.filter((id) => !byId(id).done);
}

function milestoneColour(id) {
  const index = graph.milestones.findIndex((milestone) => milestone.id === id);
  return MILESTONE_COLOURS[index % MILESTONE_COLOURS.length];
}

function draw() {
  document.title = `${graph.title} · graph`;
  view.title.textContent = graph.title;
  view.message.hidden = graph.nodes.length > 0;
  if (graph.nodes.length === 0) view.message.textContent = "No issues to show.";
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
  // The legend doubles as the switches: click a status to collapse its issues into dots.
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
          title: off ? `${name}: shown as dots. Click to show the cards.` : `${name}: click to collapse into dots.`,
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
  const chain = new Set([id]);
  const walk = (start, next) => {
    const queue = [start];
    while (queue.length) {
      for (const other of next(byId(queue.pop()))) {
        if (!chain.has(other)) {
          chain.add(other);
          queue.push(other);
        }
      }
    }
  };
  const upstream = new Set();
  const downstream = new Set();
  walk(id, (node) => node.blockedBy);
  for (const member of chain) upstream.add(member);
  chain.clear();
  chain.add(id);
  walk(id, (node) => node.blocks);
  for (const member of chain) downstream.add(member);
  return { upstream, downstream };
}

function drawGraph() {
  const width = layoutColumns();
  const height = PAD * 2 + Math.max(0, graph.height - 1) * ROW_PITCH + CARD_H;
  view.canvas.style.width = `${width}px`;
  view.canvas.style.height = `${height}px`;
  view.edges.setAttribute("width", width);
  view.edges.setAttribute("height", height);
  world.width = width;
  world.height = height;
  drawMinimap();
  if (fitted) fit(false);
  else applyViewport();

  const chain = selected ? chainOf(selected) : null;
  const lit = (id) => chain && (chain.upstream.has(id) || chain.downstream.has(id));
  const litEdge = (edge) =>
    chain &&
    ((chain.upstream.has(edge.from) && chain.upstream.has(edge.to)) ||
      (chain.downstream.has(edge.from) && chain.downstream.has(edge.to)));

  view.edges.classList.toggle("focused", !!chain);
  view.cards.classList.toggle("focused", !!chain);

  // Lines first, lit ones last so they sit on top.
  const lines = graph.edges.map((edge) => {
    const classes = ["edge"];
    if (edge.cyclic) classes.push("cyclic");
    else if (byId(edge.from).done) classes.push("met");
    if (litEdge(edge)) classes.push("lit");
    const group = svg("g", { class: classes.join(" ") });
    const { path, head } = route(edge);
    group.append(svg("path", { class: "line", d: path }), svg("path", { class: "head", d: head }));
    return group;
  });
  lines.sort((a, b) => Number(a.classList.contains("lit")) - Number(b.classList.contains("lit")));
  view.edges.replaceChildren(...lines);

  view.cards.replaceChildren(
    ...graph.nodes.map((node) => {
      const classes = [node.collapsed ? "pin" : "card", statusClass(node)];
      if (node.id === selected) classes.push("selected");
      if (lit(node.id)) classes.push("lit");
      const pick = (event) => {
        event.stopPropagation();
        select(node.id === selected ? null : node.id);
      };
      if (node.collapsed) {
        // A collapsed issue: a dot that still carries its lines, its name on hover, and opens the panel.
        const place = box(node);
        const pin = el("button", {
          class: classes.join(" "),
          type: "button",
          "data-id": node.id,
          title: `${node.id} · ${node.title} (${statusText(node)})`,
          "aria-label": `${node.id} ${node.title}`,
        });
        pin.style.left = `${place.cx - DOT_R}px`;
        pin.style.top = `${place.mid - DOT_R}px`;
        pin.style.width = pin.style.height = `${DOT_R * 2}px`;
        pin.addEventListener("click", pick);
        return pin;
      }
      const due = node.dueDate
        ? el("span", { class: !node.done && isPast(node.dueDate) ? "due overdue" : "due", text: shortDay(node.dueDate) })
        : el("span", { class: "due" });
      const card = el("button", { class: classes.join(" "), type: "button", "data-id": node.id }, [
        el("span", { class: "top" }, [
          el("span", { class: "id mono", text: node.id }),
          el("span", { class: "state", text: statusText(node) }),
        ]),
        el("span", { class: "title", text: node.title }),
        el("span", { class: "bottom" }, [
          el("span", { class: "who" }, [
            el("span", { class: "dot", style: `background:${milestoneColour(node.milestone)}` }),
            node.assignee ?? "Unassigned",
          ]),
          due,
        ]),
      ]);
      card.style.left = `${columns[node.col].x}px`;
      card.style.top = `${nodeTop(node.y)}px`;
      card.style.width = `${CARD_W}px`;
      card.style.height = `${CARD_H}px`;
      card.addEventListener("click", pick);
      return card;
    }),
  );
}

/** The SVG path of one edge, and the arrowhead at its end. */
function route(edge) {
  const points = edge.points;
  const last = points.length - 1;
  const backwards = points[last][0] <= points[0][0]; // only a loop edge can point left
  const source = box(byId(edge.from));
  const target = box(byId(edge.to));
  let fromX = source.right;
  let fromY = source.mid;
  let path = `M${fromX},${fromY}`;
  for (let index = 1; index <= last; index++) {
    const column = columns[points[index][0]];
    const toX = index === last ? target.left : column.x;
    const toY = index === last ? target.mid : nodeMid(points[index][1]);
    const bend = backwards ? 120 : (toX - fromX) / 2;
    path += ` C${fromX + bend},${fromY} ${toX - bend},${toY} ${toX},${toY}`;
    if (index < last) {
      // Straight through the column the line is passing.
      fromX = column.x + column.width;
      fromY = toY;
      path += ` L${fromX},${fromY}`;
    }
  }
  return { path, head: `M${target.left},${target.mid} l-8,-4.5 v9 z` };
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

/** Glide so that this issue's card is in the middle of the stage. */
function centreOn(id) {
  const node = byId(id);
  const place = box(node);
  viewport.x = view.stage.clientWidth / 2 - place.cx * viewport.k;
  viewport.y = view.stage.clientHeight / 2 - place.mid * viewport.k;
  fitted = false;
  applyViewport(true);
}

/** The small map: one block per card. Redrawn with the graph. */
function drawMinimap() {
  const scale = Math.min(MAP_W / world.width, MAP_H / world.height);
  view.minimap.setAttribute("viewBox", `0 0 ${world.width} ${world.height}`);
  view.minimap.setAttribute("width", world.width * scale);
  view.minimap.setAttribute("height", world.height * scale);
  view.minimap.style.display = graph.nodes.length ? "" : "none";
  view.mapNodes.replaceChildren(
    ...graph.nodes.map((node) => {
      const place = box(node);
      // On the map a dot is drawn larger than life, or it would vanish.
      const half = node.collapsed ? 26 : CARD_H / 2;
      return svg("rect", {
        class: `${statusClass(node)}${node.id === selected ? " selected" : ""}`,
        x: node.collapsed ? place.cx - half : place.left,
        y: place.mid - half,
        width: node.collapsed ? half * 2 : place.right - place.left,
        height: half * 2,
        rx: node.collapsed ? half : 14,
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

function drawDetail() {
  const node = selected && byId(selected);
  view.detail.hidden = !node;
  if (!node) {
    view.detail.replaceChildren();
    return;
  }
  const close = el("button", { class: "close", type: "button", title: "Close", text: "×" });
  close.addEventListener("click", () => select(null));

  const milestone = graph.milestones.find((entry) => entry.id === node.milestone);
  const rows = [
    ["Status", statusText(node) === node.state.name ? node.state.name : `${node.state.name} · ${statusText(node)}`],
    ["Owner", node.assignee ?? "Unassigned"],
    ["Due", node.dueDate ? shortDay(node.dueDate) + (!node.done && isPast(node.dueDate) ? " (overdue)" : "") : "No date"],
    ["Milestone", milestone ? milestone.name : "None"],
    ["Priority", PRIORITIES[node.priority] ?? "None"],
  ];
  const list = el("dl");
  for (const [name, value] of rows) list.append(el("dt", { text: name }), el("dd", { text: value }));

  const links = (ids) =>
    ids.length === 0
      ? [el("div", { class: "none", text: "Nothing" })]
      : ids.map((id) => {
          const other = byId(id);
          const link = el("button", { class: "link", type: "button" }, [
            el("span", { class: "dot", style: `background:var(--${statusClass(other) || "todo"})` }),
            el("span", { class: "id mono", text: other.id }),
            el("span", { text: other.title }),
          ]);
          link.addEventListener("click", () => select(id, true));
          return link;
        });

  const parts = [close, el("div", { class: "id mono", text: node.id }), el("h2", { text: node.title })];
  // Only ever link to Linear itself, whatever the data says.
  if (node.url.startsWith("https://linear.app/")) {
    parts.push(el("a", { href: node.url, target: "_blank", rel: "noopener noreferrer", text: "Open in Linear ↗" }));
  }
  parts.push(
    list,
    el("h3", { text: `Blocked by (${node.blockedBy.length})` }),
    ...links(node.blockedBy),
    el("h3", { text: `Blocks (${node.blocks.length})` }),
    ...links(node.blocks),
  );
  view.detail.replaceChildren(...parts);
}

function select(id, scroll = false) {
  selected = id;
  history.replaceState(null, "", id ? `#${encodeURIComponent(id)}` : location.pathname);
  drawGraph();
  drawDetail();
  if (id && scroll) centreOn(id);
}

// --- Wiring ----------------------------------------------------------------

view.refresh.addEventListener("click", async () => {
  view.refresh.disabled = true;
  await load(true);
  view.refresh.disabled = false;
});
view.zoomIn.addEventListener("click", () => zoomAtCentre(ZOOM_STEP));
view.zoomOut.addEventListener("click", () => zoomAtCentre(1 / ZOOM_STEP));
view.zoomFit.addEventListener("click", () => fit());

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
    const box = view.stage.getBoundingClientRect();
    const amount = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
    // A trackpad pinch arrives as a wheel event with ctrlKey set and small numbers.
    const factor = Math.exp(-amount * (event.ctrlKey ? 0.01 : 0.0018));
    zoomAt(event.clientX - box.left, event.clientY - box.top, viewport.k * factor);
  },
  { passive: false },
);
view.stage.addEventListener("dblclick", (event) => {
  if (event.target.closest(".card, .pin, .controls, #minimap")) return;
  const box = view.stage.getBoundingClientRect();
  zoomAt(event.clientX - box.left, event.clientY - box.top, viewport.k * 1.6, true);
});

// Click or drag on the small map to look at that part of the graph.
let mapDrag = false;
const lookAt = (event) => {
  const box = view.minimap.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * world.width;
  const y = ((event.clientY - box.top) / box.height) * world.height;
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

load();
