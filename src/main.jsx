// Claude Pit entry: loads the snapshot, draws the sidebar and routes between pages. Inside the installed
// desktop app it also polls `collect.py --live`, reads memory files, searches transcripts, saves the
// budget, keeps a menu bar item and sends notifications.
import "./styles.css";
import { PAGES, GROUPS, Icon, Logo, useNow, rel, fmt, T, usd, plural, issues, needsLook, upcomingRuns } from "./ui.jsx";
import * as P from "./pages.jsx";

const { useState, useEffect, useRef } = React;
const VIEWS = { overview: P.Overview, live: P.Live, events: P.Events, automations: P.Automations, schedule: P.Schedule,
  usage: P.Usage, history: P.History, skills: P.Skills, plugins: P.Plugins, mcp: P.Mcp, agents: P.Agents, hooks: P.Hooks,
  memory: P.Memory, health: P.Health, settings: P.Settings };
const ALIASES = { activity: "usage" };
const routeOf = () => { const h = location.hash.slice(1); const id = ALIASES[h] || h; return VIEWS[id] ? id : "overview"; };
const PYTHONS = ["python3", "/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"];

// One-file build inlines the data; the artifact fetches data.json (daily) and library.json (rarely changes).
async function load() {
  if (window.__PIT_DATA__) return window.__PIT_DATA__;
  const get = (file) => fetch(file, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status}`);
    return r.json();
  });
  const [live, library] = await Promise.all([get("data.json"), get("library.json")]);
  return { ...library, ...live };
}
function normalize(d) {
  for (const k of ["automations", "hooks", "plugins", "mcp", "skills", "agents", "commands", "health", "history", "events", "memory"]) d[k] = d[k] || [];
  for (const a of d.automations) { a.steps = a.steps || []; a.runs = a.runs || []; a.connectors = a.connectors || []; }
  d.activity = d.activity || { days: [], window: 30, totals: {}, models: [], projects: [], skills_used: [], tools: [] };
  d.cost = d.cost || { today: 0, month: 0, window: 0, budget: null };
  d.live = d.live || { at: d.generated_at, running: [], recent: [], limits: null };
  return d;
}

// ---------- icons drawn for the desktop app
function canvasIcon(size, draw) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d"));
  return c.toDataURL("image/png");
}
const dockIcon = () => canvasIcon(256, (g) => {
  g.fillStyle = "#2d3142"; g.beginPath(); g.roundRect(0, 0, 256, 256, 56); g.fill();
  g.strokeStyle = "#f5f5f5"; g.lineWidth = 18; g.beginPath(); g.arc(128, 128, 60, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = "#bf4520"; g.beginPath(); g.arc(128, 128, 22, 0, 2 * Math.PI); g.fill();
});
const trayIcon = () => canvasIcon(36, (g) => { // template image: black on transparent, macOS recolours it
  g.strokeStyle = "#000"; g.lineWidth = 3.5; g.beginPath(); g.arc(18, 18, 12, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = "#000"; g.beginPath(); g.arc(18, 18, 5, 0, 2 * Math.PI); g.fill();
});

// Runs python3 with fixed arguments (no shell) and resolves its stdout.
function spawnOnce(desktop, py, args) {
  return new Promise((resolve, reject) => {
    let out = "", err = "", done = false;
    const p = desktop.childProcess.spawn(py, args);
    const timer = setTimeout(() => { if (!done) { p.kill().catch(() => {}); finish(reject, new Error("timed out")); } }, 60000);
    const finish = (fn, value) => { if (!done) { done = true; clearTimeout(timer); fn(value); } };
    p.stdout.on("data", (chunk) => { out += chunk; });
    p.stderr.on("data", (chunk) => { err += chunk; });
    p.on("error", (e) => finish(reject, e));
    p.on("close", (code) => (code === 0 ? finish(resolve, out)
      : finish(reject, new Error(err.trim().split("\n").pop() || `exit code ${code}`))));
  });
}

// Live mode: "live" (polling), "prompt" / "denied" (needs full access), "install", "error" or "snapshot".
function useDesktop(data) {
  const [live, setLive] = useState(null);
  const [mode, setMode] = useState("snapshot");
  const [error, setError] = useState("");
  const [full, setFull] = useState(false);
  const [perms, setPerms] = useState({});
  const [trayOn, setTrayOn] = useState(false);
  const [budget, setBudget] = useState(null);
  const r = useRef({ desktop: null, py: "", dir: "", timer: 0, on: false, last: null, tray: false, notify: false });

  const python = async (args) => {
    const s = r.current;
    for (const py of s.py ? [s.py] : PYTHONS) {
      try { const out = await spawnOnce(s.desktop, py, [`${s.dir}/collect.py`, ...args]); s.py = py; return out; }
      catch (e) { if (s.py || !/ENOENT|not found/i.test(e.message || "")) throw e; }
    }
    throw new Error("python3 not found");
  };
  const notify = (body) => {
    const s = r.current;
    if (s.desktop && s.notify) s.desktop.notification.show({ body: body.slice(0, 300) }).catch(() => {});
  };
  const poll = async () => {
    const s = r.current;
    clearTimeout(s.timer);
    if (!s.on) return;
    const visible = document.visibilityState === "visible";
    if (visible || s.tray) { // with a menu bar item the app keeps watching while its window is hidden
      try {
        const next = JSON.parse(await python(["--live"]));
        for (const x of next.running) {
          const before = s.last && s.last.running.find((y) => y.id === x.id);
          if (before && before.status === "busy" && x.status !== "busy") notify(`${x.title}: ${x.doing}`);
        }
        s.last = next; setLive(next); setMode("live"); setError("");
      } catch (e) { setError(e.message || String(e)); setMode("error"); s.on = false; return; }
    }
    s.timer = setTimeout(poll, visible ? 5000 : 30000);
  };
  const start = async () => {
    const s = r.current;
    try {
      const home = await s.desktop.os.homedir();
      const dir = String(data.pit_dir || "").replace(/^~(?=\/|$)/, home);
      if (!/^\/[\w ./-]+$/.test(dir)) throw new Error("unexpected Claude Pit folder");
      s.dir = dir; s.on = true; setFull(true);
      poll();
    } catch (e) { setError(e.message || String(e)); setMode("error"); }
  };

  useEffect(() => {
    if (!data) return undefined;
    let gone = false;
    (async () => {
      if (!window.claude || !window.claude.use) return;
      const d = await window.claude.use("desktop").catch(() => null);
      if (gone || !d) return;
      r.current.desktop = d;
      if (d.app && d.app.dock) d.app.dock.setIcon(dockIcon()).catch(() => {});
      if (!d.childProcess) {
        const st = await d.install.state().catch(() => "unavailable");
        if (!gone) setMode(st === "available" ? "install" : "snapshot");
        return;
      }
      const st = await d.permissions.state().catch(() => ({}));
      if (gone) return;
      setPerms(st);
      r.current.notify = st.notifications === "granted";
      if (st["menu-bar"] === "granted") { r.current.tray = true; setTrayOn(true); }
      const fa = st["full-access"];
      if (fa === "granted") start();
      else setMode(fa === "denied" ? "denied" : fa === "prompt" ? "prompt" : "snapshot");
    })();
    const onVisible = () => { if (document.visibilityState === "visible" && r.current.on) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true; r.current.on = false; clearTimeout(r.current.timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [data]);

  const d = () => r.current.desktop;
  // Permission requests run from a click, as the desktop app requires before it asks the person.
  const ask = (name) => d().permissions.request([name]).then((m) => { setPerms((p) => ({ ...p, ...m })); return m[name]; });
  const fail = (e) => { setError(e.message || String(e)); setMode("error"); };
  return {
    live, mode, error, full, perms, trayOn, budget, notify,
    enable: () => ask("full-access").then((st) => (st === "granted" ? start() : setMode(st === "denied" ? "denied" : "prompt"))).catch(fail),
    manage: () => d().permissions.manage().catch(() => {}),
    install: () => d().install.request().then((res) => { if (res === "installed") setMode("snapshot"); }).catch(() => {}),
    readFile: (path) => d().fs.readFile(path, "utf8"),
    search: (q) => python(["--search", q]).then((out) => JSON.parse(out)),
    saveBudget: async (n) => {
      const file = `${r.current.dir}/cache/settings.json`;
      let cur = {};
      try { cur = JSON.parse(await d().fs.readFile(file, "utf8")); } catch (e) { /* first save */ }
      cur.monthly_budget_usd = n;
      await d().fs.writeFile(file, JSON.stringify(cur, null, 1), "utf8");
      setBudget(n || 0);
    },
    toggleTray: () => (r.current.tray
      ? d().tray.remove().then(() => { r.current.tray = false; setTrayOn(false); })
      : ask("menu-bar").then((st) => { if (st === "granted") { r.current.tray = true; setTrayOn(true); } })).catch(() => {}),
    enableNotify: () => ask("notifications").then((st) => {
      r.current.notify = st === "granted";
      if (st === "granted") notify("Claude Pit notifications are on.");
    }).catch(() => {}),
    setTray: (options) => d() && d().tray.set(options).catch(() => {}),
    show: () => d() && d().window.show().catch(() => {}),
  };
}

// What the menu bar item says: working sessions or the next run, then a short status menu.
function trayOptions(view, now, show) {
  const running = view.live.running, busy = running.filter((s) => s.status === "busy");
  const next = upcomingRuns(view.automations, 7, now)[0];
  const lines = [
    busy.length ? `Working: ${busy.map((s) => s.title).join(", ")}` : running.length ? `${plural(running.length, "session")} open, none working` : "No session open",
    next ? `Next: ${next.a.name}, ${fmt(next.t, T.full)}` : "No run in the next 7 days",
    `Cost today ${usd(view.cost.today)} · this month ${usd(view.cost.month)}`,
    ...((view.live.limits && view.live.limits.windows) || []).map((w) => `${w.label}: ${w.percent}%`),
  ];
  return {
    icon: trayIcon(),
    title: busy.length ? `${busy.length} working` : next ? fmt(next.t, T.time) : "",
    toolTip: lines[0].slice(0, 100),
    menu: [{ label: "Open Claude Pit", click: show }, { type: "separator" }, ...lines.map((label) => ({ label: label.slice(0, 80), enabled: false }))],
  };
}

function Sidebar({ data, route, now, ctl, onClose }) {
  const alerts = needsLook(issues(data, now)).length;
  const running = data.live.running.length, busy = data.live.running.some((s) => s.status === "busy");
  const badge = (p) => {
    if (p.id === "health") return alerts > 0 && <span className="n alert">{alerts}</span>;
    if (p.id === "live") return running > 0 && <span className={`n${busy ? " alert" : ""}`}>{running}</span>;
    return p.count && <span className="n">{p.count(data)}</span>;
  };
  return (
    <aside className="side" id="sidebar">
      <div className="brand-row">
        <a className="brand" href="#overview"><Logo /><b>Claude Pit</b></a>
        <button type="button" className="iconbtn" aria-label="Close menu" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      {GROUPS.map((group) => (
        <nav className="nav" aria-label={group} key={group}>
          <p className="eyebrow">{group}</p>
          {PAGES.filter((p) => p.group === group).map((p) => (
            <a key={p.id} href={`#${p.id}`} aria-current={route === p.id ? "page" : undefined}>
              <Icon name={p.icon} />
              <span>{p.label}</span>
              {badge(p)}
            </a>
          ))}
        </nav>
      ))}
      <div className="side-foot">
        <span>{ctl.mode === "live" ? "Live" : `Snapshot ${rel(data.generated_at, now)}`}</span>
        <span className="mono">/claude-pit to refresh</span>
        {ctl.mode === "install" && <button type="button" className="btn" onClick={ctl.install}>Install as app</button>}
      </div>
    </aside>
  );
}

function Toast({ toast, onClose }) {
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.ok ? "Copied " : "Copy this: "}<code className="sel">{toast.text}</code>{toast.hint ? ` ${toast.hint}` : ""}</span>
      <button type="button" className="iconbtn" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
    </div>
  );
}

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(routeOf);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(0);
  const now = useNow(30000);
  const desk = useDesktop(data);
  useEffect(() => { load().then((d) => setData(normalize(d))).catch((e) => setError(e.message || String(e))); }, []);
  useEffect(() => {
    const go = (id) => { setRoute(id); setOpen(false); window.scrollTo(0, 0); };
    // Internal links switch page in React state first; the hash is a bookmark where the host allows it.
    const onClick = (e) => {
      const a = e.target.closest && e.target.closest('a[href^="#"]');
      const id = a && a.getAttribute("href").slice(1);
      if (!id || !VIEWS[id] || e.metaKey || e.ctrlKey) return;
      e.preventDefault();
      go(id);
      if (location.hash.slice(1) !== id) try { location.hash = id; } catch (err) { /* hash not allowed here */ }
    };
    const onHash = () => go(routeOf());
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("click", onClick);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  useEffect(() => { document.body.classList.toggle("lock", open); }, [open]);

  const view = data && { ...data, live: desk.live || data.live,
    cost: desk.budget == null ? data.cost : { ...data.cost, budget: desk.budget || null } };
  // Menu bar item follows the data; warnings become one notification each.
  useEffect(() => { if (view && desk.trayOn) desk.setTray(trayOptions(view, now, desk.show)); }, [desk.trayOn, desk.live, data, now, desk.budget]);
  useEffect(() => {
    if (!view || desk.perms.notifications !== "granted") return;
    for (const h of issues(view, now).filter((x) => x.level === "warning")) {
      const key = `pit-alert:${h.title}`;
      try { if (localStorage.getItem(key)) continue; localStorage.setItem(key, "1"); } catch (e) { /* no storage: notify anyway */ }
      desk.notify(`${h.title}. ${h.detail || ""}`);
    }
  }, [data, desk.perms.notifications]);

  const copy = (text, hint) => {
    const done = (ok) => {
      setToast({ text, hint, ok });
      clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(null), 8000);
    };
    try { navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); } catch (e) { done(false); }
  };

  if (error) return <p className="boot">Could not load the snapshot: {error}</p>;
  if (!view) return <p className="boot">Loading…</p>;
  const ctl = { ...desk, copy };
  const View = VIEWS[route];
  const page = PAGES.find((p) => p.id === route);
  return (
    <div className={`app${open ? " open" : ""}`}>
      <Sidebar data={view} route={route} now={now} ctl={ctl} onClose={() => setOpen(false)} />
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="top">
          <button type="button" className="iconbtn" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar"
            onClick={() => setOpen(true)}><Icon name="menu" size={20} /></button>
          <b>{page.label}</b>
        </header>
        <main className="page"><View data={view} now={now} ctl={ctl} /></main>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
