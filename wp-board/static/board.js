// Crosspane work-package board. Talks only to the local board server (serve.py).
// Rendering is incremental: each card, lane and feed list is rebuilt only when its data changed.

const $ = (sel, root = document) => root.querySelector(sel);

const CLASSES = {
  done: { label: "Merged", color: "var(--c-done)" },
  active: { label: "Active", color: "var(--c-active)" },
  spec: { label: "Spec'd", color: "var(--c-spec)" },
  planned: { label: "Planned", color: "var(--c-planned)" },
  blocked: { label: "Blocked", color: "var(--c-blocked)" },
  aside: { label: "Split / superseded", color: "var(--c-aside)" },
};
const COUNTED = ["done", "active", "spec", "planned", "blocked"];
const CHANGED_MS = 4000;
const LOAD_DEBOUNCE_MS = 250;

const ICON = {
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17 19 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  move: '<svg viewBox="0 0 24 24"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  flight: '<svg viewBox="0 0 24 24"><path d="M4 12h9M4 7h5M4 17h5"/><path d="M14 7l5 5-5 5"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/></svg>',
  branch: '<svg viewBox="0 0 24 24"><circle cx="7" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 7v10M17 10c0 4-6 3-9.5 7"/></svg>',
  report: '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.4v.1"/></svg>',
  unlock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.6-1.7"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-2 4 2 4H5"/></svg>',
};

const KINDS = {
  note: { label: "Note", color: "var(--muted)", icon: ICON.note },
  progress: { label: "Progress", color: "var(--c-active)", icon: ICON.pulse },
  blocker: { label: "Blocker", color: "var(--c-blocked)", icon: ICON.alert },
  unblock: { label: "Unblocked", color: "var(--c-ready)", icon: ICON.unlock },
  ready: { label: "Ready for review", color: "var(--c-ready)", icon: ICON.flag },
};
const kindOf = (k) => KINDS[k] || KINDS.note;

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`wpboard.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`wpboard.${key}`, JSON.stringify(value));
    } catch {
      /* private mode: nothing to keep */
    }
  },
};

const state = {
  board: null,
  version: -1,
  filter: "all",
  query: "",
  lanesOpen: store.get("lanes", {}),
  seen: store.get("seen", null),
  fresh: new Set(),
  moved: new Map(),
  byKey: new Map(),
  byFile: new Map(),
  byId: new Map(),
  docs: new Set(),
  openKey: null,
  laneEls: new Map(),
  rendered: false,
  faviconSig: "",
};

// Writes only when the value differs, so unchanged regions cause no DOM mutation or relayout.
function setText(el, text) {
  text = String(text);
  if (el._text !== text) {
    el._text = text;
    el.textContent = text;
  }
}

function setHTML(el, html) {
  if (el._html !== html) {
    el._html = html;
    el.innerHTML = html;
  }
}

// ---------- text ----------

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const ID_RE = /\b(WP-[A-Z]?\d+(?:\.\d+)?[a-z0-9]*|[A-Z]{2,}-v0|C-P\d+|P\d+[a-z]?)\b/g;

function linkIds(html) {
  return html.replace(ID_RE, (m) => {
    const id = m.replace(/\.+$/, "");
    const tail = m.slice(id.length);
    if (state.byKey.has(id)) return `<button class="wp-link" data-key="${esc(id)}">${id}</button>${tail}`;
    if (state.docs.has(`${id}.md`)) return `<button class="doc-link" data-file="${esc(id)}.md">${id}</button>${tail}`;
    return m;
  });
}

function linkFor(text, href) {
  const raw = href.replace(/&amp;/g, "&");
  if (/^https?:\/\//.test(raw)) return `<a class="ext" href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  const name = raw.split("#")[0].split("/").pop();
  if (name.endsWith(".md")) {
    const key = state.byFile.get(name);
    if (key && !raw.includes("/")) return `<button class="wp-link" data-key="${esc(key)}">${text}</button>`;
    if (state.docs.has(name) && !raw.includes("/")) return `<button class="doc-link" data-file="${esc(name)}">${text}</button>`;
  }
  return `<span class="plain-link" title="${href}">${text}</span>`;
}

function rich(escaped) {
  const links = [];
  let s = escaped.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    links.push(linkFor(text, href));
    return `\u0000${links.length - 1}\u0000`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*]*?)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  s = linkIds(s);
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => links[Number(n)]);
}

function inline(md) {
  return String(md ?? "")
    .split(/(`[^`]+`)/g)
    .map((part) => (part.length > 1 && part.startsWith("`") && part.endsWith("`") ? `<code>${esc(part.slice(1, -1))}</code>` : rich(esc(part))))
    .join("");
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let buf = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { buf += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { cells.push(buf.trim()); buf = ""; } else buf += c;
  }
  cells.push(buf.trim());
  return cells;
}

function renderMarkdown(md) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  const blockStart = (l) => /^(#{1,6}\s|```|\s*\||>\s?|\s*([-*+]|\d+\.)\s+|\s*(-{3,}|\*{3,})\s*$)/.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const n = Math.min(h[1].length + 1, 6);
      out.push(`<h${n}>${inline(h[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push("<hr>");
      i++;
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (m) { items.push({ depth: Math.min(3, Math.floor(m[1].length / 2)), text: m[3] }); i++; continue; }
        if (l.trim() && /^\s+/.test(l) && items.length) { items[items.length - 1].text += ` ${l.trim()}`; i++; continue; }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(
        `<${tag}>${items
          .map((it) => {
            const box = it.text.match(/^\[([ xX])\]\s+(.*)$/);
            const body = box ? `<span class="box${box[1] === " " ? "" : " on"}"></span>${inline(box[2])}` : inline(it.text);
            return `<li class="d${it.depth}">${body}</li>`;
          })
          .join("")}</${tag}>`,
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !blockStart(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}

// ---------- time ----------

function rel(ts) {
  if (!ts) return "";
  const s = Date.now() / 1000 - ts;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// Times carry no relative text in the HTML signature; refreshTimes fills them in, so a list whose
// data is unchanged is never rebuilt just because a minute passed.
function timeTag(ts) {
  return `<time data-ts="${ts}" title="${esc(new Date(ts * 1000).toLocaleString())}"></time>`;
}

function refreshTimes(root = document) {
  root.querySelectorAll("time[data-ts]").forEach((t) => setText(t, rel(Number(t.dataset.ts))));
  if (state.board) setText($("#updated"), `tracker edited ${rel(state.board.readme_mtime)}`);
}

// ---------- data ----------

function allItems(board) {
  return [...board.lanes.flatMap((l) => l.items), ...board.untracked];
}

function totalsOf(items) {
  const t = { done: 0, active: 0, spec: 0, planned: 0, blocked: 0, aside: 0 };
  items.forEach((i) => t[i.cls]++);
  t.items = items.length;
  t.counted = COUNTED.reduce((n, c) => n + t[c], 0);
  t.percent = t.counted ? Math.round((1000 * t.done) / t.counted) / 10 : 0;
  return t;
}

function index(board) {
  state.byKey = new Map();
  state.byFile = new Map();
  state.byId = new Map();
  for (const item of allItems(board)) {
    state.byKey.set(item.key, item);
    if (!state.byId.has(item.id)) state.byId.set(item.id, item.key);
    if (item.file && !state.byFile.has(item.file)) state.byFile.set(item.file, item.key);
  }
  state.docs = new Set(board.docs || []);
}

function computeFresh(board) {
  const items = allItems(board);
  if (state.seen === null) {
    state.seen = Object.fromEntries(items.filter((i) => !i.arrived).map((i) => [i.key, i.cls]));
    store.set("seen", state.seen);
  }
  state.fresh = new Set(items.filter((i) => !(i.key in state.seen)).map((i) => i.key));
  state.moved = new Map(items.filter((i) => i.key in state.seen && state.seen[i.key] !== i.cls).map((i) => [i.key, state.seen[i.key]]));
}

function markSeen() {
  if (!state.board) return;
  state.seen = Object.fromEntries(allItems(state.board).map((i) => [i.key, i.cls]));
  store.set("seen", state.seen);
}

function matches(item) {
  if (state.filter === "new") {
    if (!state.fresh.has(item.key) && !state.moved.has(item.key)) return false;
  } else if (state.filter === "agent-blocked") {
    if (!item.agent?.blocker) return false;
  } else if (state.filter === "agent-ready") {
    if (!item.agent?.ready) return false;
  } else if (state.filter !== "all" && item.cls !== state.filter) return false;
  if (!state.query) return true;
  const a = item.agent;
  const hay = `${item.id} ${item.title} ${item.h1} ${item.branch} ${item.os} ${item.status} ${item.group} ${a ? `${a.step} ${a.last?.text} ${a.authors.join(" ")}` : ""}`.toLowerCase();
  return state.query.split(/\s+/).every((t) => hay.includes(t));
}

// ---------- hero ----------

function renderHero() {
  const t = state.board.totals;
  setText($("#pct"), t.percent % 1 ? t.percent.toFixed(1) : String(t.percent));
  setText($("#done-n"), t.done);
  setText($("#counted-n"), t.counted);
  renderBar($("#bar"), t);
  refreshTimes($("#hero"));
  renderChips();
  renderOwner();
}

function renderBar(bar, t) {
  if (!bar.children.length) bar.innerHTML = COUNTED.map((c) => `<div class="seg ${c}"></div>`).join("");
  const sig = COUNTED.map((c) => t[c]).join(",");
  if (bar._sig === sig) return;
  bar._sig = sig;
  const segs = bar.children;
  COUNTED.forEach((c, n) => {
    segs[n].style.width = `${t.counted ? (100 * t[c]) / t.counted : 0}%`;
    segs[n].title = `${t[c]} ${CLASSES[c].label.toLowerCase()}`;
  });
}

function renderChips() {
  const host = $("#chips");
  const t = state.board.totals;
  const items = allItems(state.board);
  const defs = [
    { f: "all", label: "All", n: t.items, color: "var(--text-2)" },
    ...["done", "active", "spec", "planned", "blocked", "aside"].map((c) => ({ f: c, label: CLASSES[c].label, n: t[c], color: CLASSES[c].color })),
    { f: "new", label: "New since last visit", n: state.fresh.size + state.moved.size, color: "var(--accent)" },
    { f: "agent-blocked", label: "Agent blockers", n: items.filter((i) => i.agent?.blocker).length, color: "var(--c-blocked)" },
    { f: "agent-ready", label: "Ready for review", n: items.filter((i) => i.agent?.ready).length, color: "var(--c-ready)" },
  ];
  if (!host.children.length) {
    host.innerHTML = defs
      .map((d) => `<button class="fchip" data-f="${d.f}" style="--c:${d.color}" aria-pressed="false"><i></i><span>${esc(d.label)}</span><b>0</b></button>`)
      .join("");
  }
  defs.forEach((d) => {
    const chip = host.querySelector(`[data-f="${d.f}"]`);
    const pressed = String(state.filter === d.f);
    if (chip.getAttribute("aria-pressed") !== pressed) chip.setAttribute("aria-pressed", pressed);
    const disabled = d.n === 0 && state.filter !== d.f && d.f !== "all";
    if (chip.disabled !== disabled) chip.disabled = disabled;
    setText(chip.querySelector("b"), d.n);
  });
}

function renderOwner() {
  const actions = state.board.owner_actions || [];
  const done = actions.filter((a) => a.done).length;
  setText($("#owner-count"), actions.length ? `· ${done}/${actions.length}` : "");
  setHTML(
    $("#owner"),
    actions
      .map((a) => `<li class="${a.done ? "done" : ""}"><span class="check">${a.done ? ICON.check : ""}</span><span class="owner-text" title="${esc(a.text)}">${inline(a.text)}</span></li>`)
      .join("") || '<li><span></span><span class="owner-text">None listed.</span></li>',
  );
}

function renderNewbar() {
  const bar = $("#newbar");
  const n = state.fresh.size;
  const m = state.moved.size;
  if (!n && !m) {
    if (!bar.hidden) bar.hidden = true;
    return;
  }
  const parts = [];
  if (n) parts.push(`<strong>${n}</strong> new`);
  if (m) parts.push(`<strong>${m}</strong> moved`);
  if (bar.hidden) bar.hidden = false;
  setHTML(
    bar,
    `<div>${parts.join(" · ")} <span>since your last visit</span></div>
    <div class="actions">${state.filter === "new" ? '<button class="btn" data-act="show-all">Show all</button>' : '<button class="btn" data-act="show-new">Show them</button>'}
    <button class="btn primary" data-act="seen">Mark seen</button></div>`,
  );
}


// ---------- roadmap ----------

const STATES = { done: "Done", active: "In progress", next: "Next", later: "Later" };

function barHTML(t) {
  return `<div class="bar">${COUNTED.map((c) => `<div class="seg ${c}" style="width:${t.counted ? (100 * t[c]) / t.counted : 0}%" title="${t[c]} ${CLASSES[c].label.toLowerCase()}"></div>`).join("")}</div>`;
}

function pctText(t) {
  return t.percent % 1 ? t.percent.toFixed(1) : String(t.percent);
}

function nextHTML(rows) {
  if (!rows?.length) return "";
  return `<div class="rm-next">Next: ${rows.map((r) => `<button class="wp-link" data-key="${esc(r.key)}" title="${esc(`${r.title} (${r.status_short})`)}">${esc(r.id)}</button>`).join(", ")}</div>`;
}

function countsHTML(t) {
  return `<div class="rm-counts"><span><b>${t.done}</b>/${t.counted} merged</span>${["active", "spec", "planned", "blocked"]
    .filter((c) => t[c])
    .map((c) => `<span style="--c:${CLASSES[c].color}"><i></i>${t[c]} ${CLASSES[c].label.toLowerCase()}</span>`)
    .join("")}${t.aside ? `<span>${t.aside} split/superseded not counted</span>` : ""}</div>`;
}

function platformHTML(p) {
  const t = p.totals;
  const head = p.few
    ? `<span class="rm-plat-pct ns">Not started</span>`
    : `<span class="rm-plat-pct${t.percent >= 100 ? " full" : ""}">${pctText(t)}<small>%</small></span>`;
  const notes = [p.note, p.unlabelled ? `Includes ${p.unlabelled} row${p.unlabelled === 1 ? "" : "s"} with no OS cell.` : ""].filter(Boolean);
  return `<div class="rm-plat${p.few ? " few" : ""}"><div class="rm-plat-top"><span class="rm-plat-name">${esc(p.label)}</span>${head}</div>
    ${barHTML(t)}${p.few ? `<div class="rm-counts"><span><b>${t.done}</b>/${t.counted} groundwork rows merged</span></div>` : countsHTML(t)}${notes.map((n) => `<div class="rm-note">${esc(n)}</div>`).join("")}${nextHTML(p.next)}</div>`;
}

function streamHTML(w) {
  const t = w.totals;
  return `<li><button class="rm-lane" data-lane="${esc(w.id)}" title="Go to ${esc(w.title)}">${esc(w.title)}</button><span class="rm-frac">${t.done}/${t.counted}</span><span class="rm-pct${t.percent >= 100 ? " full" : ""}">${Math.round(t.percent)}%</span>${barHTML(t)}</li>`;
}

function milestoneHTML(m) {
  const t = m.totals;
  const meta = t
    ? `<div class="rm-meta">${barHTML(t)}<span>${t.done}/${t.counted} merged · ${pctText(t)}%</span>${m.derived ? "" : '<span class="rm-src">· state set by hand</span>'}</div>`
    : "";
  const doc = m.doc && state.docs.has(m.doc) ? ` <button class="doc-link" data-file="${esc(m.doc)}">${esc(m.doc.replace(/\.md$/, ""))}</button>` : "";
  return `<li class="${m.state}"><span class="rm-state ${m.state}">${STATES[m.state] || esc(m.state)}</span><span class="rm-title">${esc(m.title)}${doc}</span>${meta}${
    m.note ? `<div class="rm-note">${esc(m.note)}</div>` : ""
  }${nextHTML(m.next)}</li>`;
}

function renderRoadmap() {
  const rm = state.board.roadmap;
  const section = $("#roadmap");
  if (!rm) {
    if (!section.hidden) section.hidden = true;
    return;
  }
  if (section.hidden) section.hidden = false;
  setHTML($("#rm-platforms"), rm.platforms.map(platformHTML).join(""));
  setHTML($("#rm-streams"), rm.workstreams.map(streamHTML).join(""));
  setHTML($("#rm-phases"), rm.milestones.filter((m) => m.kind === "phase").map(milestoneHTML).join(""));
  setHTML($("#rm-tracks"), rm.milestones.filter((m) => m.kind !== "phase").map(milestoneHTML).join(""));
}

function setRoadmapOpen(open) {
  $("#roadmap").classList.toggle("collapsed", !open);
  $("#rm-toggle").setAttribute("aria-expanded", String(open));
}

function goToLane(id) {
  const el = state.laneEls.get(id);
  if (!el) return;
  if (state.filter !== "all" || state.query) {
    state.filter = "all";
    state.query = "";
    $("#search").value = "";
    renderChips();
    renderNewbar();
  }
  if (el.classList.contains("collapsed")) {
    state.lanesOpen[id] = true;
    store.set("lanes", state.lanesOpen);
  }
  renderLanes("filter");
  el.scrollIntoView({ block: "start" });
  el.querySelector(".lane-head").focus({ preventScroll: true });
}

// ---------- lanes ----------

function laneList() {
  const board = state.board;
  const items = allItems(board);
  const lanes = [];
  const flight = items.filter((i) => i.in_flight);
  if (flight.length)
    lanes.push({
      id: "__flight",
      special: "flight",
      title: "In flight",
      subtitle: "Delegated, in review, or with an open worktree",
      notes: [],
      items: flight,
      totals: totalsOf(flight),
    });
  if (board.untracked.length)
    lanes.push({
      id: "__untracked",
      special: "untracked",
      title: "Not in the tracker",
      subtitle: "Spec files in docs/wp that no tracker row lists",
      notes: [],
      items: board.untracked,
      totals: totalsOf(board.untracked),
    });
  board.lanes.forEach((l, n) => lanes.push({ ...l, index: n + 1 }));
  return lanes;
}

function laneOpen(lane, filtering) {
  if (filtering) return true;
  if (lane.id in state.lanesOpen) return state.lanesOpen[lane.id];
  if (lane.special) return true;
  return lane.totals.percent < 100;
}

function laneShell(lane) {
  const el = document.createElement("section");
  el.className = `lane${lane.special ? ` special ${lane.special}` : ""}`;
  el.dataset.lane = lane.id;
  el.innerHTML = `
    <header class="lane-head" tabindex="0" role="button">
      <div class="lane-index"></div>
      <div class="lane-titles"><h2></h2><div class="lane-sub"></div></div>
      <div class="lane-mini"></div>
      <div class="lane-stats"><span class="lane-count"></span><span class="lane-pct"></span>${ICON.chev}</div>
    </header>
    <div class="bar thin"></div>
    <div class="lane-body"><div class="lane-content"><div class="lane-notes"></div><div class="groups"></div></div></div>`;
  const head = el.querySelector(".lane-head");
  const toggle = () => {
    const open = el.classList.contains("collapsed");
    state.lanesOpen[lane.id] = open;
    store.set("lanes", state.lanesOpen);
    el.classList.toggle("collapsed", !open);
    head.setAttribute("aria-expanded", String(open));
    // A lane that was collapsed skipped its card work; fill it now.
    if (open) renderLanes("filter");
  };
  head.addEventListener("click", toggle);
  head.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
  return el;
}

function renderLanes(reason) {
  const host = $("#lanes");
  const lanes = laneList();
  const filtering = state.filter !== "all" || !!state.query;
  const keep = new Set();
  let visibleLanes = 0;
  lanes.forEach((lane, n) => {
    let el = state.laneEls.get(lane.id);
    if (!el) {
      el = laneShell(lane);
      state.laneEls.set(lane.id, el);
    }
    keep.add(lane.id);
    if (host.children[n] !== el) host.insertBefore(el, host.children[n] || null);

    setHTML(el.querySelector(".lane-index"), lane.special === "flight" ? ICON.flight : lane.special === "untracked" ? ICON.file : String(lane.index).padStart(2, "0"));
    setText(el.querySelector("h2"), lane.title);
    setText(el.querySelector(".lane-sub"), lane.subtitle || "");
    const t = lane.totals;
    const pct = el.querySelector(".lane-pct");
    if (lane.special) {
      setText(pct, t.items);
      const noun = lane.special === "untracked" ? "spec file" : "package";
      setText(el.querySelector(".lane-count"), t.items === 1 ? noun : `${noun}s`);
    } else {
      pct.classList.toggle("full", t.percent >= 100);
      setText(pct, `${Math.round(t.percent)}%`);
      setText(el.querySelector(".lane-count"), `${t.done}/${t.counted}`);
    }
    setHTML(
      el.querySelector(".lane-mini"),
      ["active", "spec", "planned", "blocked"]
        .filter((c) => t[c])
        .map((c) => `<span style="--c:${CLASSES[c].color}" title="${t[c]} ${CLASSES[c].label.toLowerCase()}"><i></i>${t[c]}</span>`)
        .join(""),
    );
    renderBar(el.querySelector(".bar"), t);
    const notes = el.querySelector(".lane-notes");
    setHTML(notes, (lane.notes || []).map((p) => `<p>${inline(p)}</p>`).join(""));
    if (notes.hidden !== !(lane.notes || []).length) notes.hidden = !(lane.notes || []).length;

    const items = lane.items.filter(matches);
    const hide = filtering && !items.length;
    if (el.hidden !== hide) el.hidden = hide;
    if (!el.hidden) visibleLanes++;
    const open = laneOpen(lane, filtering);
    el.classList.toggle("collapsed", !open);
    const head = el.querySelector(".lane-head");
    if (head.getAttribute("aria-expanded") !== String(open)) head.setAttribute("aria-expanded", String(open));
    // Collapsed lanes keep their old cards until opened: nothing there is visible.
    if (open && !el.hidden) syncGroups(el.querySelector(".groups"), lane, items, reason);
  });
  for (const [id, el] of state.laneEls) {
    if (!keep.has(id)) {
      el.remove();
      state.laneEls.delete(id);
    }
  }
  let empty = $("#lanes > .empty");
  if (!visibleLanes) {
    if (!empty) {
      empty = document.createElement("div");
      empty.className = "empty panel";
      host.append(empty);
    }
    empty.textContent = "No work packages match.";
  } else if (empty) empty.remove();
}

function syncGroups(host, lane, items, reason) {
  const groups = new Map();
  for (const item of items) {
    const g = lane.special ? "" : item.group || "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(item);
  }
  const showLabels = groups.size > 1;
  host._groups = host._groups || new Map();
  const keep = new Set();
  [...groups.keys()].forEach((name, n) => {
    let g = host._groups.get(name);
    if (!g) {
      g = document.createElement("div");
      g.className = "group";
      g.innerHTML = '<div class="group-label section-label"></div><div class="grid"></div>';
      host._groups.set(name, g);
    }
    keep.add(name);
    if (host.children[n] !== g) host.insertBefore(g, host.children[n] || null);
    const label = g.querySelector(".group-label");
    if (label.hidden !== (!showLabels || !name)) label.hidden = !showLabels || !name;
    setText(label, name);
    syncGrid(g.querySelector(".grid"), groups.get(name), reason);
  });
  for (const [name, g] of host._groups) {
    if (!keep.has(name)) {
      g.remove();
      host._groups.delete(name);
    }
  }
}

function syncGrid(grid, items, reason) {
  const prev = grid._els || new Map();
  const next = new Map();
  const want = new Set(items.map((i) => i.key));
  for (const [k, el] of prev) if (!want.has(k)) el.remove();
  items.forEach((item, n) => {
    let el = prev.get(item.key);
    const created = !el;
    if (created) {
      el = document.createElement("article");
      el.dataset.key = item.key;
      el.tabIndex = 0;
    }
    updateCard(el, item, created, reason);
    next.set(item.key, el);
    if (grid.children[n] !== el) grid.insertBefore(el, grid.children[n] || null);
  });
  grid._els = next;
}

function cardHTML(item, fresh, movedFrom) {
  const badges = [];
  if (fresh) badges.push('<span class="tag new">New</span>');
  else if (movedFrom) badges.push(`<span class="tag moved" title="was ${esc(CLASSES[movedFrom]?.label || movedFrom)}">Moved</span>`);
  const a = item.agent;
  if (a?.blocker) badges.push(`<span class="tag agent-block" title="${esc(`${a.blocker.author}: ${a.blocker.text}`)}">Blocked</span>`);
  else if (a?.ready) badges.push(`<span class="tag agent-ready" title="${esc(`${a.ready.author}: ${a.ready.text || "ready for review"}`)}">Ready</span>`);
  for (const t of item.tags || []) badges.push(`<span class="tag">${esc(t)}</span>`);
  const icons = [];
  if (a) icons.push(`<span class="notes-n" title="${a.count} agent update${a.count === 1 ? "" : "s"} · last: ${esc(a.last?.text || kindOf(a.last?.kind).label)}">${ICON.note}<b>${a.count}</b></span>`);
  if (item.worktree) icons.push(`<span class="wt" title="Worktree .worktrees/${esc(item.worktree.name)}">${ICON.branch}</span>`);
  if (item.has_report) icons.push(`<span title="Report filed">${ICON.report}</span>`);
  const title = item.title || item.h1 || "(untitled)";
  const status = item.tracked === false && item.status_short === "not in the tracker" ? "not in the tracker" : item.status_short || item.status;
  return `<div class="card-top"><span class="wp-id">${esc(item.id)}</span>${item.id_note ? `<span class="id-note">${esc(item.id_note)}</span>` : ""}<span class="sp"></span>${
      badges.length ? `<span class="badges">${badges.join("")}</span>` : ""
    }${item.os ? `<span class="os" title="${esc(item.os)}">${esc(item.os)}</span>` : ""}</div>
    <h3 class="card-title">${inline(title)}</h3>${agentStrip(item)}
    <div class="card-foot"><span class="chip" title="${esc(item.status)}"><i></i><span>${esc(status)}</span></span>${
      item.branch ? `<span class="branch" title="${esc(item.branch)}">${esc(item.branch)}</span>` : ""
    }${icons.length ? `<span class="icons">${icons.join("")}</span>` : ""}</div>`;
}

// The latest agent step on unfinished work: a meter when a percent was posted, a blocker or a
// hand-off when one is open.
function agentStrip(item) {
  const a = item.agent;
  if (!a || item.cls === "done" || item.cls === "aside") return "";
  let kind = a.last.kind;
  let text = a.last.text;
  if (a.blocker) [kind, text] = ["blocker", a.blocker.text];
  else if (a.ready) [kind, text] = ["ready", a.ready.text || "Ready for review"];
  else if (a.step && kind !== "note") [kind, text] = ["progress", a.step];
  const meter = a.percent != null ? `<div class="meter" title="${a.percent}% (agent estimate)"><i style="width:${a.percent}%"></i></div>` : "";
  return `<div class="agent-line k-${kind}" title="${esc(`${a.last.author} · ${new Date(a.last.time * 1000).toLocaleString()}`)}">
    <span class="k-icon">${kindOf(kind).icon}</span><span class="agent-text">${a.percent != null ? `<b>${a.percent}%</b> ` : ""}${inline(text || kindOf(kind).label)}</span></div>${meter}`;
}

function cardClass(item) {
  return `card st-${item.cls}${item.tracked === false ? " untracked" : ""}${item.in_flight ? " in-flight" : ""}${item.agent?.blocker ? " agent-blocked" : ""}${state.openKey === item.key ? " open" : ""}`;
}

// Marks a card that just changed with a static tint for a few seconds. No animation.
function flagChanged(el) {
  el.classList.add("changed");
  clearTimeout(el._changedTimer);
  el._changedTimer = setTimeout(() => el.classList.remove("changed"), CHANGED_MS);
}

function updateCard(el, item, created, reason) {
  const fresh = state.fresh.has(item.key);
  const movedFrom = state.moved.get(item.key);
  // The data signature decides whether the card changed; the full one adds the reader's "seen"
  // state, which re-renders the badges without counting as a change.
  const dataSig = JSON.stringify([item.title, item.h1, item.status, item.status_short, item.cls, item.branch, item.os, item.worktree?.name, item.has_report, item.in_flight, item.tracked, item.id_note, item.tags, item.agent]);
  const sig = `${dataSig}|${fresh}|${movedFrom || ""}`;
  if (el._sig === sig) return;
  const changed = !created && reason === "update" && el._dataSig !== dataSig;
  el._sig = sig;
  el._dataSig = dataSig;
  const keepChanged = el.classList.contains("changed");
  el.className = cardClass(item);
  if (keepChanged) el.classList.add("changed");
  el.innerHTML = cardHTML(item, fresh, movedFrom);
  el.setAttribute("aria-label", `${item.id}: ${item.title || item.h1} (${item.status_short || item.status})`);
  if (changed || (created && reason === "update" && fresh)) flagChanged(el);
}

// ---------- feed ----------

function wpRef(id) {
  const key = state.byId.get(id);
  return key ? `<button class="wp-link" data-key="${esc(key)}">${esc(id)}</button>` : `<span class="wp-id">${esc(id)}</span>`;
}

function kindLabel(n) {
  const k = kindOf(n.kind);
  return `<span class="k-label" style="--c:${k.color}">${esc(n.kind === "progress" && n.percent != null ? `${n.percent}%` : k.label)}</span>`;
}

function renderActivity() {
  const notes = state.board.activity || [];
  const total = state.board.activity_total || 0;
  setText($("#activity-count"), total ? `· ${total}` : "");
  setHTML(
    $("#activity"),
    notes
      .map((n) => {
        const k = kindOf(n.kind);
        return `<li class="k-${esc(n.kind)}" style="--c:${k.color}"><span class="k-dot">${k.icon}</span><span class="subj">${wpRef(n.wp)} ${kindLabel(n)} <span class="note-text">${inline(n.text.split("\n")[0])}</span></span><span class="who">${esc(n.author)}${n.source !== n.author ? ` · ${esc(n.source)}` : ""} · ${timeTag(n.time)}</span></li>`;
      })
      .join("") ||
      '<li class="hint"><span></span><span class="subj">No agent updates yet. Agents post with <code>scripts/wp-board/wp-note</code> or <code>POST /api/notes</code>.</span></li>',
  );
}

function renderFeed() {
  renderActivity();
  const commits = state.board.commits || [];
  setHTML(
    $("#commits"),
    commits.map((c) => `<li><span class="sha">${esc(c.sha)}</span><span class="subj">${linkIds(esc(c.subject))}</span>${timeTag(c.time)}</li>`).join("") ||
      '<li><span></span><span class="subj">No commits read.</span></li>',
  );
  const recent = state.board.recent || [];
  setHTML(
    $("#recent"),
    recent
      .map((r) => {
        const item = state.byKey.get(r.key);
        const color = item ? CLASSES[item.cls].color : "var(--muted)";
        const title = item ? item.title || item.h1 : r.file;
        return `<li><span class="mark" style="--c:${color}"></span><span class="subj"><button class="wp-link" data-key="${esc(r.key)}">${esc(r.id)}</button> ${inline(title)}</span>${timeTag(r.mtime)}</li>`;
      })
      .join(""),
  );
  refreshTimes($(".feed"));
}

// ---------- drawer ----------

function depends(text) {
  if (!text) return "";
  const re = /(?:WP-)?[A-Z]?\d+\.\d+[a-z0-9]*|\bC-P\d+\b|\bP\d+[a-z]?\b|\b[A-Z]\d+[a-z]?\b/g;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    const tok = m[0];
    const key = [tok, `WP-${tok}`].find((k) => state.byKey.has(k));
    out += inline(text.slice(last, m.index));
    out += key ? `<button class="wp-link" data-key="${esc(key)}">${esc(tok)}</button>` : esc(tok);
    last = m.index + tok.length;
  }
  return out + inline(text.slice(last));
}

function chipFor(item) {
  return `<span class="chip st-${item.cls}" style="--c:${CLASSES[item.cls].color}" title="${esc(item.status)}"><i></i>${esc(item.status_short || item.status)}</span>`;
}

function openDrawer() {
  $("#drawer").classList.add("on");
  $("#drawer").setAttribute("aria-hidden", "false");
  $("#scrim").classList.add("on");
}

function closeDrawer() {
  $("#drawer").classList.remove("on");
  $("#drawer").setAttribute("aria-hidden", "true");
  $("#scrim").classList.remove("on");
  document.querySelectorAll(".card.open").forEach((c) => c.classList.remove("open"));
  state.openKey = null;
  if (location.hash) history.replaceState(null, "", location.pathname);
}

function highlightCard(key) {
  document.querySelectorAll(".card.open").forEach((c) => c.classList.remove("open"));
  document.querySelectorAll(`.card[data-key="${CSS.escape(key)}"]`).forEach((c) => c.classList.add("open"));
}

async function openItem(key) {
  const item = state.byKey.get(key);
  if (!item) return;
  state.openKey = key;
  highlightCard(key);
  history.replaceState(null, "", `#${encodeURIComponent(key)}`);
  const body = $("#drawer-body");
  body.innerHTML = `<div class="d-top"><span class="wp-id">${esc(item.id)}</span>${chipFor(item)}</div>
    <h2 class="d-title">${inline(item.title || item.h1)}</h2><div class="skeleton"></div><div class="skeleton" style="width:70%"></div>`;
  openDrawer();
  let data;
  try {
    const res = await fetch(`/api/wp?key=${encodeURIComponent(key)}`);
    data = await res.json();
  } catch {
    data = { item, spec: null, markdown: "", git: null };
  }
  if (state.openKey !== key) return;
  body.innerHTML = drawerHTML(data.item || item, data);
  refreshTimes(body);
  body.scrollTop = 0;
  const full = body.querySelector(".d-full");
  if (full && data.markdown) {
    const fill = () => {
      const md = full.querySelector(".md");
      if (!md.innerHTML) md.innerHTML = renderMarkdown(data.markdown);
    };
    if (full.open) fill();
    full.addEventListener("toggle", fill);
  }
  $("#drawer-close").focus({ preventScroll: true });
}

function drawerHTML(item, data) {
  const spec = data.spec;
  const git = data.git;
  const lane = state.board.lanes.find((l) => l.id === item.lane);
  const meta = [];
  meta.push(["Status", esc(item.status) + (item.status_note && !item.status.includes(item.status_note) ? ` <span class="id-note">${esc(item.status_note)}</span>` : "")]);
  if (lane) meta.push(["Lane", esc(lane.title) + (item.group ? ` · ${esc(item.group)}` : "")]);
  else if (item.tracked === false) meta.push(["Tracker", "Not listed in <code>docs/wp/README.md</code>"]);
  if (item.os) meta.push(["OS", esc(item.os)]);
  if (item.depends) meta.push(["Depends on", depends(item.depends)]);
  if (item.branch) meta.push(["Branch", `<code>${esc(item.branch)}</code>`]);
  if (item.worktree) meta.push(["Worktree", `<code>.worktrees/${esc(item.worktree.name)}</code>`]);
  for (const [k, v] of item.fields || []) meta.push([esc(k), inline(v)]);
  if (data.source) meta.push(["Spec", `<code>${esc(data.source)}</code>${item.mtime ? ` · edited ${timeTag(item.mtime)}` : ""}`]);
  else if (item.file) meta.push(["Spec", `<code>docs/wp/${esc(item.file)}</code> <span class="id-note">not found</span>`]);
  if (item.changed_at) meta.push(["Moved", `${esc(CLASSES[item.previous_cls]?.label || item.previous_cls)} → ${esc(CLASSES[item.cls].label)} ${timeTag(item.changed_at)}`]);

  const parts = [];
  parts.push(`<div class="d-top"><span class="wp-id">${esc(item.id)}</span>${chipFor(item)}${(item.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>`);
  parts.push(`<h2 class="d-title">${inline(item.title || spec?.h1 || item.id)}</h2>`);
  parts.push(`<dl class="d-meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`);
  if (spec?.why) parts.push(`<section class="d-section"><div class="section-label">Why</div><p>${inline(spec.why.replace(/^\*\*(Why|Goal)[.:]?\*\*:?\s*/, ""))}</p></section>`);
  parts.push(`<section class="d-section d-updates">${updatesHTML(item, data.updates || [])}</section>`);
  if (git && (git.last || git.dirty != null)) {
    const stats = [];
    if (git.last) stats.push(`<div class="stat wide"><span>Last commit on <code>${esc(git.branch)}</code></span><div>${esc(git.last.sha)} · ${linkIds(esc(git.last.subject))} · ${timeTag(git.last.time)}</div></div>`);
    if (git.ahead != null) stats.push(`<div class="stat"><b>${git.ahead}</b><span>commits ahead of master</span></div>`);
    if (git.dirty != null) stats.push(`<div class="stat"><b>${git.dirty}</b><span>uncommitted files in the worktree</span></div>`);
    parts.push(`<section class="d-section"><div class="section-label">Git</div><div class="d-git">${stats.join("")}</div></section>`);
  }
  if (spec?.meta?.length) {
    const rows = spec.meta.filter(([k]) => !/^(goal|why|status)$/i.test(k));
    if (rows.length) parts.push(`<section class="d-section"><div class="section-label">From the spec</div><dl class="d-meta">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${inline(v)}</dd>`).join("")}</dl></section>`);
  }
  if (spec?.report_title) parts.push(`<section class="d-section"><div class="section-label">${esc(spec.report_title)}</div><div class="d-report">${spec.report.split(/\n\n/).map((p) => `<p>${inline(p)}</p>`).join("")}</div></section>`);
  if (data.markdown) parts.push(`<details class="d-full"${spec?.why || spec?.report_title ? "" : " open"}><summary><span class="sum-icon">${ICON.file}</span>Full spec<code>${esc(data.source)}</code>${ICON.chev}</summary><div class="md"></div></details>`);
  else if (!item.file) parts.push('<p class="id-note">This row has no spec file.</p>');
  return parts.join("");
}

// The agent-updates section of the drawer: open blocker or hand-off, the latest meter, then every
// update newest first. `updates` is newest first.
function updatesHTML(item, updates) {
  const a = item.agent;
  const out = [`<div class="section-label">Agent updates${updates.length ? ` · ${updates.length}` : ""}</div>`];
  if (a?.blocker) out.push(`<div class="callout warn">${ICON.alert}<div><b>Blocked</b> · ${esc(a.blocker.author)} · ${timeTag(a.blocker.time)}<p>${inline(a.blocker.text)}</p></div></div>`);
  else if (a?.ready) out.push(`<div class="callout ready">${ICON.flag}<div><b>Ready for review</b> · ${esc(a.ready.author)} · ${timeTag(a.ready.time)}${a.ready.text ? `<p>${inline(a.ready.text)}</p>` : ""}</div></div>`);
  if (a?.percent != null) out.push(`<div class="d-meter"><div class="meter big"><i style="width:${a.percent}%"></i></div><b>${a.percent}%</b><span>${a.ready ? "" : inline(a.step || "")}</span></div>`);
  if (!updates.length) {
    out.push(`<p class="id-note">No updates yet. From the worktree or the repo:</p><pre class="hint-cmd"><code>scripts/wp-board/wp-note progress ${esc(item.id)} -p 40 "what is done, what is next"</code></pre>`);
    return out.join("");
  }
  out.push(
    `<ol class="timeline">${updates
      .map((n) => {
        const k = kindOf(n.kind);
        const body = n.text ? n.text.split(/\n{2,}/).map((p) => `<p>${inline(p).replace(/\n/g, "<br>")}</p>`).join("") : "";
        return `<li class="k-${esc(n.kind)}" style="--c:${k.color}"><span class="k-dot">${k.icon}</span><div class="t-head">${kindLabel(n)}<span class="who">${esc(n.author)}${n.source !== n.author ? ` · ${esc(n.source)}` : ""}</span>${timeTag(n.time)}</div>${body}</li>`;
      })
      .join("")}</ol>`,
  );
  return out.join("");
}

async function refreshUpdates(key) {
  const item = state.byKey.get(key);
  const host = $("#drawer-body .d-updates");
  if (!item || !host) return;
  try {
    const res = await fetch(`/api/notes?wp=${encodeURIComponent(item.id)}&limit=0`, { cache: "no-store" });
    const data = await res.json();
    if (state.openKey !== key || !res.ok) return;
    host.innerHTML = updatesHTML(item, data.notes || []);
    refreshTimes(host);
  } catch {
    /* the next update retries */
  }
}

async function openDoc(file) {
  state.openKey = null;
  highlightCard("");
  const body = $("#drawer-body");
  body.innerHTML = `<div class="d-top"><span class="wp-id">${esc(file)}</span></div><div class="skeleton"></div><div class="skeleton" style="width:60%"></div>`;
  openDrawer();
  try {
    const res = await fetch(`/api/doc?file=${encodeURIComponent(file)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error);
    body.innerHTML = `<div class="d-top"><span class="wp-id">${esc(file)}</span><span class="tag">document</span></div>
      <h2 class="d-title">${inline(d.h1 || file)}</h2><div class="md">${renderMarkdown(d.markdown.replace(/^#\s+.*\n/, ""))}</div>`;
  } catch (e) {
    body.innerHTML = `<p class="id-note">Could not read ${esc(file)}: ${esc(e.message)}</p>`;
  }
  body.scrollTop = 0;
}

// ---------- live updates ----------

function diff(prev, next) {
  const before = new Map(allItems(prev).map((i) => [i.key, i]));
  const changes = [];
  for (const item of allItems(next)) {
    const old = before.get(item.key);
    if (!old) changes.push({ kind: "new", item });
    else if (old.cls !== item.cls) changes.push({ kind: "moved", item, from: old.cls });
    else if (old.status !== item.status) changes.push({ kind: "status", item, from: old.status_short });
  }
  return changes;
}

function toast(html, kind = "") {
  const host = $("#toasts");
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.innerHTML = html;
  host.prepend(t);
  while (host.children.length > 4) host.lastElementChild.remove();
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 150);
  }, 7000);
}

function announce(changes) {
  const shown = changes.slice(0, 3);
  for (const c of shown) {
    const id = `<button class="wp-link" data-key="${esc(c.item.key)}">${esc(c.item.id)}</button>`;
    if (c.kind === "new") {
      const where = c.item.tracked === false ? "spec file, not in the tracker yet" : esc(state.board.lanes.find((l) => l.id === c.item.lane)?.title || "");
      toast(`<span class="t-icon">${ICON.plus}</span><div>New work package ${id} <span class="arrow">·</span><span class="id-note">${where}</span></div>`);
    } else if (c.kind === "moved") {
      const done = c.item.cls === "done";
      toast(
        `<span class="t-icon">${done ? ICON.check : ICON.move}</span><div>${id} ${esc(CLASSES[c.from].label)}<span class="arrow">→</span><strong>${esc(c.item.status_short || CLASSES[c.item.cls].label)}</strong></div>`,
        done ? "done" : "",
      );
    } else {
      toast(`<span class="t-icon">${ICON.move}</span><div>${id} ${esc(c.from)}<span class="arrow">→</span>${esc(c.item.status_short)}</div>`);
    }
  }
  if (changes.length > shown.length) toast(`<span class="t-icon">${ICON.plus}</span><div>and ${changes.length - shown.length} more changes</div>`);
}

function announceUpdates(prev, next) {
  const before = new Set((prev.activity || []).map((n) => n.id));
  const oldest = Math.min(...(prev.activity || []).map((n) => n.time), Infinity);
  const fresh = (next.activity || []).filter((n) => !before.has(n.id) && (n.time >= oldest || before.size < 24));
  for (const n of fresh.slice(0, 2).reverse()) {
    const k = kindOf(n.kind);
    const text = n.text.split("\n")[0];
    toast(
      `<span class="t-icon" style="--c:${k.color}">${k.icon}</span><div><b>${esc(n.author)}</b> on ${wpRef(n.wp)} ${kindLabel(n)}${text ? `<span class="arrow">·</span>${inline(text.length > 110 ? `${text.slice(0, 108)}…` : text)}` : ""}</div>`,
      n.kind === "blocker" ? "warn" : n.kind === "ready" ? "done" : "",
    );
  }
  if (fresh.length > 2) toast(`<span class="t-icon">${ICON.note}</span><div>and ${fresh.length - 2} more agent updates</div>`);
}

async function load(reason) {
  let board;
  try {
    const res = await fetch("/api/board", { cache: "no-store" });
    board = await res.json();
    if (!res.ok) throw new Error(board.error || res.statusText);
  } catch (e) {
    showError(`Could not read the board: ${e.message}`);
    return;
  }
  const tag = `${board.version}@${board.server_started}`;
  if (tag === state.version) return;
  const prev = state.board;
  state.board = board;
  state.version = tag;
  index(board);
  computeFresh(board);
  render(state.rendered ? "update" : "initial");
  if (prev && reason === "update") {
    announce(diff(prev, board));
    announceUpdates(prev, board);
    const open = state.openKey && state.byKey.get(state.openKey);
    const before = open && allItems(prev).find((i) => i.key === open.key);
    if (open && JSON.stringify(before?.agent) !== JSON.stringify(open.agent)) refreshUpdates(open.key);
  }
  showError(board.error ? `The last rebuild failed; showing the previous snapshot.\n${board.error}` : "");
  if (!state.rendered) {
    state.rendered = true;
    const key = decodeURIComponent(location.hash.slice(1));
    if (key && state.byKey.has(key)) openItem(key);
  }
  if (state.openKey && reason === "update" && state.byKey.has(state.openKey)) highlightCard(state.openKey);
}

// Bursts of version events collapse into one fetch; a version that arrives mid-fetch triggers
// exactly one more fetch afterwards.
const loader = { timer: 0, running: false, again: false };

function scheduleLoad() {
  clearTimeout(loader.timer);
  loader.timer = setTimeout(runLoad, LOAD_DEBOUNCE_MS);
}

async function runLoad() {
  if (loader.running) {
    loader.again = true;
    return;
  }
  loader.running = true;
  try {
    await load(state.rendered ? "update" : "initial");
  } finally {
    loader.running = false;
    if (loader.again) {
      loader.again = false;
      scheduleLoad();
    }
  }
}

function showError(text) {
  const el = $("#error");
  if (el.hidden !== !text) el.hidden = !text;
  setText(el, text);
}

function render(reason) {
  renderHero();
  renderRoadmap();
  renderNewbar();
  renderLanes(reason);
  renderFeed();
  const title = `${state.board.totals.percent}% · Crosspane work packages`;
  if (document.title !== title) document.title = title;
  favicon(state.board.totals);
}

function connect() {
  const live = $("#live");
  const setLive = (s, label) => {
    if (live.dataset.state === s) return;
    live.dataset.state = s;
    live.querySelector("span").textContent = label;
  };
  const es = new EventSource("/events");
  es.addEventListener("open", () => setLive("live", "Live"));
  es.addEventListener("error", () => setLive("reconnecting", "Reconnecting"));
  es.addEventListener("version", (e) => {
    setLive("live", "Live");
    if (e.data !== state.version) scheduleLoad();
  });
}

function favicon(t) {
  const sig = `${t.done}/${t.active}/${t.counted}`;
  if (state.faviconSig === sig) return;
  state.faviconSig = sig;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d");
  g.fillStyle = "#131c25";
  g.beginPath();
  g.arc(32, 32, 31, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = "#26333f";
  g.beginPath();
  g.arc(32, 32, 23, 0, Math.PI * 2);
  g.stroke();
  const start = -Math.PI / 2;
  const doneEnd = start + (t.counted ? t.done / t.counted : 0) * Math.PI * 2;
  const activeEnd = doneEnd + (t.counted ? t.active / t.counted : 0) * Math.PI * 2;
  g.strokeStyle = "#5a9df0";
  g.beginPath();
  g.arc(32, 32, 23, doneEnd, activeEnd);
  g.stroke();
  g.strokeStyle = "#3fb67f";
  g.beginPath();
  g.arc(32, 32, 23, start, doneEnd);
  g.stroke();
  g.fillStyle = "#e4eaf0";
  g.font = "600 17px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(String(Math.floor(t.percent)), 32, 33);
  $("#favicon").href = c.toDataURL("image/png");
}

// ---------- events ----------

function setFilter(f) {
  state.filter = state.filter === f && f !== "all" ? "all" : f;
  renderChips();
  renderNewbar();
  renderLanes("filter");
}

function wire() {
  $("#chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".fchip");
    if (chip && !chip.disabled) setFilter(chip.dataset.f);
  });
  $("#newbar").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "show-new") setFilter("new");
    if (act === "show-all") setFilter("all");
    if (act === "seen") {
      markSeen();
      computeFresh(state.board);
      if (state.filter === "new") state.filter = "all";
      render("filter");
    }
  });
  let debounce;
  $("#search").addEventListener("input", (e) => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      state.query = e.target.value.trim().toLowerCase();
      renderLanes("filter");
    }, 120);
  });
  document.addEventListener("click", (e) => {
    const link = e.target.closest(".wp-link, .doc-link");
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      if (link.dataset.key) openItem(link.dataset.key);
      else openDoc(link.dataset.file);
      return;
    }
    const card = e.target.closest(".card");
    if (card) openItem(card.dataset.key);
  });
  $("#lanes").addEventListener("keydown", (e) => {
    const card = e.target.closest(".card");
    if (card && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      openItem(card.dataset.key);
    }
  });
  setRoadmapOpen(store.get("roadmap", true));
  const toggleRoadmap = () => {
    const open = $("#roadmap").classList.contains("collapsed");
    store.set("roadmap", open);
    setRoadmapOpen(open);
  };
  $("#rm-toggle").addEventListener("click", toggleRoadmap);
  $("#rm-toggle").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggleRoadmap();
    }
  });
  $("#rm-streams").addEventListener("click", (e) => {
    const lane = e.target.closest(".rm-lane");
    if (lane) goToLane(lane.dataset.lane);
  });
  $("#scrim").addEventListener("click", closeDrawer);
  $("#drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName);
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#search").focus();
    } else if (e.key === "Escape") {
      if ($("#drawer").classList.contains("on")) closeDrawer();
      else if (typing) {
        $("#search").value = "";
        state.query = "";
        $("#search").blur();
        renderLanes("filter");
      }
    }
  });
  addEventListener("pagehide", markSeen);
  setInterval(() => refreshTimes(), 30000);
}

wire();
load("initial").then(connect);
