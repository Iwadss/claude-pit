// Claude Pit entry: loads the snapshot, draws the sidebar and routes between pages on the URL hash.
import "./styles.css";
import { PAGES, Icon, Logo, useNow, rel, issues, needsLook } from "./ui.jsx";
import { Overview, Automations, Schedule, Activity, Skills, Plugins, Mcp, Agents, Hooks, Health } from "./pages.jsx";

const { useState, useEffect } = React;
const VIEWS = { overview: Overview, automations: Automations, schedule: Schedule, activity: Activity, skills: Skills,
  plugins: Plugins, mcp: Mcp, agents: Agents, hooks: Hooks, health: Health };
const routeOf = () => { const id = location.hash.slice(1); return VIEWS[id] ? id : "overview"; };

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
  return d;
}

// Claude desktop app: offer "Install as app" and give the installed app its own Dock icon.
function drawIcon() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d");
  g.fillStyle = "#2d3142"; g.beginPath(); g.roundRect(0, 0, 256, 256, 56); g.fill();
  g.strokeStyle = "#f5f5f5"; g.lineWidth = 18; g.beginPath(); g.arc(128, 128, 60, 0, 2 * Math.PI); g.stroke();
  g.fillStyle = "#bf4520"; g.beginPath(); g.arc(128, 128, 22, 0, 2 * Math.PI); g.fill();
  return c.toDataURL("image/png");
}
function InstallButton() {
  const [desktop, setDesktop] = useState(null);
  const [state, setState] = useState("unavailable");
  useEffect(() => {
    let live = true;
    (async () => {
      if (!window.claude || !window.claude.use) return;
      const d = await window.claude.use("desktop").catch(() => null);
      if (!d || !live) return;
      if (d.app && d.app.dock) d.app.dock.setIcon(drawIcon()).catch(() => {});
      setDesktop(d);
      setState(await d.install.state().catch(() => "unavailable"));
    })();
    return () => { live = false; };
  }, []);
  if (state !== "available") return null;
  const install = () => desktop.install.request().then((r) => r === "installed" && setState("installed")).catch(() => {});
  return <button type="button" className="btn" onClick={install}>Install as app</button>;
}

function Sidebar({ data, route, now, onClose }) {
  const alerts = needsLook(issues(data, now)).length;
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
              {p.id === "health" ? alerts > 0 && <span className="n alert">{alerts}</span>
                : p.count && <span className="n">{p.count(data)}</span>}
            </a>
          ))}
        </nav>
      ))}
      <div className="side-foot">
        <span>Snapshot {rel(data.generated_at, now)}</span>
        <span className="mono">/claude-pit to refresh</span>
        <InstallButton />
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
  const View = VIEWS[route];
  const page = PAGES.find((p) => p.id === route);
  return (
    <div className={`app${open ? " open" : ""}`}>
      <Sidebar data={data} route={route} now={now} onClose={() => setOpen(false)} />
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="top">
          <button type="button" className="iconbtn" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar"
            onClick={() => setOpen(true)}><Icon name="menu" size={20} /></button>
          <b>{page.label}</b>
        </header>
        <main className="page"><View data={data} now={now} /></main>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
