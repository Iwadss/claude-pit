// Claude Pit entry: loads the snapshot, draws the sidebar, routes between pages and, inside the installed
// desktop app, polls `collect.py --live` so the Live page follows sessions as they happen.
import "./styles.css";
import { PAGES, Icon, Logo, useNow, rel, issues, needsLook } from "./ui.jsx";
import { Overview, Live, Automations, Schedule, Activity, Skills, Plugins, Mcp, Agents, Hooks, Health } from "./pages.jsx";

const { useState, useEffect, useRef } = React;
const VIEWS = { overview: Overview, live: Live, automations: Automations, schedule: Schedule, activity: Activity,
  skills: Skills, plugins: Plugins, mcp: Mcp, agents: Agents, hooks: Hooks, health: Health };
const routeOf = () => { const id = location.hash.slice(1); return VIEWS[id] ? id : "overview"; };
const POLL_MS = 5000;
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
  for (const k of ["automations", "hooks", "plugins", "mcp", "skills", "agents", "commands", "health"]) d[k] = d[k] || [];
  for (const a of d.automations) { a.steps = a.steps || []; a.runs = a.runs || []; a.connectors = a.connectors || []; }
  d.activity = d.activity || { days: [], window: 30, totals: {}, models: [], projects: [], skills_used: [] };
  d.live = d.live || { at: d.generated_at, running: [], recent: [] };
  return d;
}

// ---------- Claude desktop app
function drawIcon() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#2d3142"; g.beginPath(); g.roundRect(0, 0, 256, 256, 56); g.fill();
  g.strokeStyle = "#f5f5f5"; g.lineWidth = 18; g.beginPath(); g.arc(128, 128, 60, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = "#bf4520"; g.beginPath(); g.arc(128, 128, 22, 0, 2 * Math.PI); g.fill();
  return c.toDataURL("image/png");
}

// Runs `python3 collect.py --live` (no shell, fixed arguments) and resolves its stdout.
function spawnOnce(desktop, py, script) {
  return new Promise((resolve, reject) => {
    let out = "", err = "", done = false;
    const p = desktop.childProcess.spawn(py, [script, "--live"]);
    const timer = setTimeout(() => { if (!done) { p.kill().catch(() => {}); reject(new Error("timed out")); } }, 15000);
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
  const r = useRef({ desktop: null, py: "", script: "", timer: 0, on: false });

  const runPython = async () => {
    const s = r.current;
    for (const py of s.py ? [s.py] : PYTHONS) {
      try { const out = await spawnOnce(s.desktop, py, s.script); s.py = py; return out; }
      catch (e) { if (s.py || !/ENOENT|not found/i.test(e.message || "")) throw e; }
    }
    throw new Error("python3 not found");
  };
  const poll = async () => {
    const s = r.current;
    clearTimeout(s.timer);
    if (!s.on) return;
    if (document.visibilityState === "visible") {
      try { setLive(JSON.parse(await runPython())); setMode("live"); setError(""); }
      catch (e) { setError(e.message || String(e)); setMode("error"); s.on = false; return; }
    }
    s.timer = setTimeout(poll, POLL_MS);
  };
  const start = async () => {
    const s = r.current;
    try {
      const home = await s.desktop.os.homedir();
      const dir = String(data.pit_dir || "").replace(/^~(?=\/|$)/, home);
      if (!/^\/[\w ./-]+$/.test(dir)) throw new Error("unexpected Claude Pit folder");
      s.script = `${dir}/collect.py`;
      s.on = true;
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
      if (d.app && d.app.dock) d.app.dock.setIcon(drawIcon()).catch(() => {});
      if (!d.childProcess) {
        const st = await d.install.state().catch(() => "unavailable");
        if (!gone) setMode(st === "available" ? "install" : "snapshot");
        return;
      }
      const st = await d.permissions.state("full-access").catch(() => "unavailable");
      if (gone) return;
      if (st === "granted") start();
      else setMode(st === "denied" ? "denied" : st === "prompt" ? "prompt" : "snapshot");
    })();
    const onVisible = () => { if (document.visibilityState === "visible" && r.current.on) poll(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true; r.current.on = false; clearTimeout(r.current.timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [data]);

  const d = () => r.current.desktop;
  return {
    live, mode, error,
    // These three run from a click, as the desktop app requires before it asks the person.
    enable: () => d().permissions.request(["full-access"]).then((m) => {
      const st = m["full-access"];
      if (st === "granted") start(); else setMode(st === "denied" ? "denied" : "prompt");
    }).catch((e) => { setError(e.message || String(e)); setMode("error"); }),
    manage: () => d().permissions.manage().catch(() => {}),
    install: () => d().install.request().then((res) => { if (res === "installed") setMode("snapshot"); }).catch(() => {}),
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
      {["Monitor", "Library", "System"].map((group) => (
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

function App() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [route, setRoute] = useState(routeOf);
  const [open, setOpen] = useState(false);
  const now = useNow(30000);
  const ctl = useDesktop(data);
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

  if (error) return <p className="boot">Could not load the snapshot: {error}</p>;
  if (!data) return <p className="boot">Loading…</p>;
  const view = ctl.live ? { ...data, live: ctl.live } : data;
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
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
