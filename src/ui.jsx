// Shared helpers and building blocks: icons, cards, pills, charts and the flow diagrams.
// React comes from the CDN as a global, so there is no import of it here.
const { useState, useEffect } = React;

export const PAGES = [
  { id: "overview", label: "Overview", icon: "grid", group: "Monitor" },
  { id: "live", label: "Live", icon: "radio", group: "Monitor" },
  { id: "events", label: "Events", icon: "list", group: "Monitor" },
  { id: "automations", label: "Automations", icon: "flow", group: "Monitor", count: (d) => d.automations.length },
  { id: "schedule", label: "Schedule", icon: "calendar", group: "Monitor" },
  { id: "usage", label: "Usage & cost", icon: "pulse", group: "Insights" },
  { id: "history", label: "History", icon: "clock", group: "Insights", count: (d) => d.history.length },
  { id: "skills", label: "Skills", icon: "spark", group: "Library", count: (d) => d.skills.length },
  { id: "plugins", label: "Plugins", icon: "box", group: "Library", count: (d) => d.plugins.length },
  { id: "mcp", label: "MCP", icon: "plug", group: "Library", count: (d) => d.mcp.length },
  { id: "agents", label: "Agents", icon: "bot", group: "Library", count: (d) => d.agents.length },
  { id: "hooks", label: "Hooks", icon: "hook", group: "Library", count: (d) => d.hooks.length },
  { id: "memory", label: "Memory", icon: "book", group: "Library", count: (d) => d.memory.length },
  { id: "health", label: "Health", icon: "shield", group: "System" },
  { id: "settings", label: "Settings", icon: "gear", group: "System" },
];
export const GROUPS = ["Monitor", "Insights", "Library", "System"];

// ---------- formatting
const nf = new Intl.NumberFormat();
const cf = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
export const num = (x) => nf.format(x || 0);
export const compact = (x) => cf.format(x || 0);
export const usd = (x) => "$" + ((x || 0) >= 100 ? Math.round(x).toLocaleString() : (x || 0).toFixed(2));
export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
export const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] || 0), 0);
export const matches = (q, ...xs) => !q || xs.join(" ").toLowerCase().includes(q.trim().toLowerCase());
export const T = {
  time: { hour: "2-digit", minute: "2-digit" },
  day: { weekday: "short", day: "numeric", month: "short" },
  full: { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" },
  date: { day: "numeric", month: "short", year: "numeric" },
  short: { day: "numeric", month: "short" },
};
export function fmt(when, opts) {
  const t = typeof when === "number" ? when : Date.parse(when);
  return isNaN(t) ? "—" : new Intl.DateTimeFormat(undefined, opts).format(t);
}
export function rel(when, now = Date.now()) {
  const ms = (typeof when === "number" ? when : Date.parse(when)) - now;
  if (isNaN(ms)) return "";
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 1) return "now";
  const s = m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  return ms > 0 ? `in ${s}` : `${s} ago`;
}
export const source = (s = "") =>
  s.startsWith("plugin:") ? s.slice(7) : s.startsWith("project:") ? `${s.slice(8)} project` : s === "you" ? "yours" : s;
export function model(m = "") {
  const x = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(m);
  if (x) return `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? "." + x[3] : ""}`;
  return m ? m[0].toUpperCase() + m.slice(1) : "";
}
export function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [ms]);
  return now;
}

// ---------- derived data
export function upcomingRuns(autos, days, now) {
  const end = now + days * 864e5, out = [];
  for (const a of autos) {
    if (!a.enabled) continue;
    const times = a.upcoming && a.upcoming.length ? a.upcoming : a.next_run_at ? [a.next_run_at] : [];
    for (const t of times) { const ms = Date.parse(t); if (ms > now && ms <= end) out.push({ a, t: ms }); }
  }
  return out.sort((x, y) => x.t - y.t);
}
export function issues(data, now) {
  const list = data.health.slice();
  if (now - Date.parse(data.generated_at) > 3 * 864e5)
    list.unshift({ level: "caution", title: `Snapshot is ${rel(data.generated_at, now).replace(" ago", " old")}`, detail: "Type /claude-pit in Claude Code to refresh." });
  if (!data.routines_synced_at)
    list.unshift({ level: "info", title: "Cloud routines not synced yet", detail: "Type /claude-pit in Claude Code to pull them in." });
  return list;
}
export const needsLook = (list) => list.filter((x) => x.level === "warning" || x.level === "caution");
export function status(a) {
  return a.problem ? ["bad", "Stopped"] : a.enabled ? ["ok", "Active"] : ["warn", "Paused"];
}
export function result(a) {
  if (a.kind === "launchd" || a.kind === "cron") return "Command output";
  const n = [a.notify && a.notify.push && "Push", a.notify && a.notify.email && "Email"].filter(Boolean).join(" + ");
  return n ? `${n} notification` : "Saved session";
}

// ---------- icons (24px grid, 1.6 stroke)
const PATHS = {
  grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
  flow: <><rect x="3" y="3" width="8" height="6" rx="1.5" /><rect x="13" y="15" width="8" height="6" rx="1.5" /><path d="M7 9v5a4 4 0 0 0 4 4h2" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  pulse: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  radio: <><circle cx="12" cy="12" r="2.2" /><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.5 5.5a9.2 9.2 0 0 0 0 13M18.5 5.5a9.2 9.2 0 0 1 0 13" /></>,
  spark: <path d="M12 3.5l2 6.5 6.5 2-6.5 2-2 6.5-2-6.5-6.5-2 6.5-2z" />,
  box: <><path d="M20.5 7.5L12 3 3.5 7.5 12 12z" /><path d="M3.5 7.5v9L12 21l8.5-4.5v-9M12 12v9" /></>,
  plug: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
  bot: <><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 4v4M9 13.5v1M15 13.5v1" /></>,
  hook: <><path d="M17 3v9a5 5 0 0 1-10 0v-1" /><path d="M4 13.5l3-3 3 3" /></>,
  shield: <><path d="M12 3l7.5 3v6c0 4.6-3.2 7.6-7.5 9-4.3-1.4-7.5-4.4-7.5-9V6z" /><path d="M9 12l2 2 4-4" /></>,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  list: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  book: <><path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z" /><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7" /></>,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>,
};
export function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{PATHS[name]}</svg>
  );
}
export function Logo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden="true">
      <rect width="28" height="28" rx="6" style={{ fill: "var(--ink)" }} />
      <circle cx="14" cy="14" r="6.5" fill="none" style={{ stroke: "var(--paper)" }} strokeWidth="2" />
      <circle cx="14" cy="14" r="2.4" style={{ fill: "var(--accent)" }} />
    </svg>
  );
}

// ---------- layout pieces
export function PageHead({ title, sub }) {
  return <header className="ph"><h1>{title}</h1>{sub && <p>{sub}</p>}</header>;
}
export function Card({ title, meta, className = "", children }) {
  return (
    <section className={`card ${className}`}>
      {title && <div className="card-h"><h2>{title}</h2>{meta && <span className="meta">{meta}</span>}</div>}
      {children}
    </section>
  );
}
export function Stat({ label, value, sub, href }) {
  const body = <><span className="k">{label}</span><span className="v">{value}</span>{sub && <span className="s">{sub}</span>}</>;
  return href ? <a className="stat" href={href}>{body}</a> : <div className="stat">{body}</div>;
}
export const Pill = ({ tone, children }) => <span className={`pill ${tone}`}>{children}</span>;
export const Tag = ({ children }) => <span className="tag">{children}</span>;
export const Empty = ({ children }) => <div className="empty">{children}</div>;
export function Search({ value, onChange, label }) {
  return (
    <label className="search">
      <Icon name="search" />
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} placeholder={label} aria-label={label} />
    </label>
  );
}
export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

// ---------- charts
// Donut: largest slice at 12 o'clock, 2px surface gaps, legend with values (identity never by colour alone).
export function Donut({ items, label, caption, format = compact }) {
  const [hot, setHot] = useState(null);
  const shown = items.filter((x) => x.value > 0).sort((a, b) => b.value - a.value);
  const total = sum(shown, "value") || 1;
  const R = 52, C = 2 * Math.PI * R, GAP = shown.length > 1 ? 2 : 0;
  let start = 0;
  const segs = shown.map((x) => {
    const len = (x.value / total) * C;
    const seg = { ...x, dash: Math.max(len - GAP, 0.5), offset: start };
    start += len;
    return seg;
  });
  const focus = (key) => () => setHot(key);
  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label={label}>
        <g transform="rotate(-90 70 70)">
          {segs.map((s) => (
            <circle key={s.key} cx="70" cy="70" r={R} fill="none" strokeWidth={hot === s.key ? 18 : 14}
              strokeDasharray={`${s.dash} ${C - s.dash}`} strokeDashoffset={-s.offset}
              style={{ stroke: s.color, opacity: hot && hot !== s.key ? 0.35 : 1 }}
              onMouseEnter={focus(s.key)} onMouseLeave={focus(null)}>
              <title>{`${s.label}: ${format(s.value)}`}</title>
            </circle>
          ))}
        </g>
        <text x="70" y="70" textAnchor="middle" className="donut-v">{format(total)}</text>
        <text x="70" y="88" textAnchor="middle" className="donut-c">{caption}</text>
      </svg>
      <ul className="legend">
        {shown.map((x) => (
          <li key={x.key} className={hot && hot !== x.key ? "dim" : ""} onMouseEnter={focus(x.key)} onMouseLeave={focus(null)}>
            <i style={{ background: x.color }} /><span>{x.label}</span><b>{format(x.value)}</b><em>{Math.round((x.value / total) * 100)}%</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Daily columns; the last one (today) is the focal mark. Hover shows the value.
export function Bars({ days, field, label, format = num }) {
  const [hot, setHot] = useState(null);
  const max = Math.max(1, ...days.map((d) => d[field] || 0));
  const mid = Math.floor(days.length / 2);
  return (
    <div className="bars">
      <div className="bars-plot" role="img" aria-label={label}>
        <span className="bars-max">{format(max)}</span>
        {days.map((d, i) => (
          <div key={d.date} className={`bar${i === days.length - 1 ? " today" : ""}${hot === i ? " hot" : ""}`}
            onMouseEnter={() => setHot(i)} onMouseLeave={() => setHot(null)}>
            <span style={{ height: d[field] ? `max(3px, ${(d[field] / max) * 100}%)` : 0 }} />
          </div>
        ))}
        {hot != null && (
          <div className="tip" style={{ left: `${((hot + 0.5) / days.length) * 100}%` }}>
            <b>{format(days[hot][field] || 0)}</b> · {fmt(days[hot].date + "T12:00:00", T.day)}
          </div>
        )}
      </div>
      <div className="bars-x">
        <span>{fmt(days[0].date + "T12:00:00", T.short)}</span>
        <span>{fmt(days[mid].date + "T12:00:00", T.short)}</span>
        <span>Today</span>
      </div>
    </div>
  );
}

// A labelled 0-100% bar; amber from 80%, red at 100%.
export function Meter({ label, pct, sub }) {
  const p = Math.max(0, Math.min(100, Math.round(pct || 0)));
  const tone = p >= 100 ? "bad" : p >= 80 ? "warn" : "";
  return (
    <div className="meter">
      <div className="meter-h"><span>{label}</span><b className="mono">{p}%</b></div>
      <div className={`meter-t ${tone}`} role="progressbar" aria-valuenow={p} aria-valuemin="0" aria-valuemax="100" aria-label={label}>
        <i style={{ width: `${p}%` }} />
      </div>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function HBars({ items, format = num }) {
  const max = Math.max(1, ...items.map((x) => x.value));
  return (
    <ul className="hbars">
      {items.map((x) => (
        <li key={x.label} title={x.title || x.label}>
          <span className="hl">{x.label}</span>
          <span className="ht"><i style={{ width: `${(x.value / max) * 100}%` }} /></span>
          <b>{format(x.value)}</b>
        </li>
      ))}
    </ul>
  );
}

// ---------- flow diagrams (diagram-design grammar: typed boxes, tag top-left, mono sublabel, muted arrows)
function Node({ kind = "", tag, name, sub, children }) {
  return (
    <div className={`fnode ${kind}`}>
      {tag && <span className="ftag">{tag}</span>}
      <b>{name || "—"}</b>
      {sub && <small>{sub}</small>}
      {children}
    </div>
  );
}
const Edge = ({ label }) => <div className="fedge" aria-hidden="true">{label && <span>{label}</span>}</div>;

export function Flow({ a }) {
  const conn = (a.connectors || []).map((c) => c.replace(/_/g, " "));
  const uses = conn.length ? `${conn.includes("Gmail") ? "Gmail" : conn[0]}${conn.length > 1 ? ` +${conn.length - 1}` : ""}` : "";
  const runSub = [model(a.model), a.permission_mode && `${a.permission_mode} mode`].filter(Boolean).join(" · ");
  const local = a.kind === "launchd" || a.kind === "cron";
  return (
    <div className="flowwrap">
      <div className="flow" role="img" aria-label={`How ${a.name} runs: ${a.schedule}, then ${a.steps.map((s) => s.label).join(", ")}, then ${result(a)}.`}>
        <Node kind="input" tag="When" name={a.schedule} sub={a.tz} />
        <Edge label="starts" />
        <div className="frow">
          <Node tag="Run" name={a.where} sub={runSub || a.origin}>{uses && <span className="uses-inline">uses {uses}</span>}</Node>
          {uses && (
            <div className="fside">
              <span className="flabel">uses</span>
              <Node kind="external" tag="MCP" name={uses} sub={plural(conn.length, "connector")} />
            </div>
          )}
        </div>
        {a.steps.map((s, i) => (
          <React.Fragment key={i}>
            <Edge />
            <Node tag={String(i + 1).padStart(2, "0")} name={s.label} sub={s.sub} />
          </React.Fragment>
        ))}
        <Edge label={local ? "" : "sends"} />
        <Node kind="focal" tag="Out" name={result(a)} sub={local ? "" : a.keeps_session ? "Same session each run" : "New session each run"} />
      </div>
    </div>
  );
}

// Horizontal chain of boxes (vertical on phones), for schedule rows and hooks.
export function MiniFlow({ nodes, label }) {
  return (
    <div className="mflow" role="img" aria-label={label}>
      {nodes.map((n, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="marrow" aria-hidden="true" />}
          <div className={`mnode ${n.kind || ""}`}>
            {n.tag && <span className="ftag">{n.tag}</span>}
            <b className={n.mono ? "mono" : ""}>{n.name}</b>
            {n.sub && <small>{n.sub}</small>}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}
