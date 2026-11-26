// One component per sidebar page. Each gets the snapshot (`data`), the current time (`now`) and `ctl`:
// desktop-app controls (live updates, file reading, search, settings) plus copy-to-clipboard.
import {
  PageHead, Card, Stat, Pill, Tag, Empty, Search, Seg, Donut, Bars, HBars, Meter, Flow, MiniFlow, Icon,
  fmt, rel, T, num, compact, usd, plural, sum, matches, source, model, upcomingRuns, issues, needsLook, status, result,
} from "./ui.jsx";

const { useState } = React;

// Fixed colour per category, so a colour always means the same thing on every chart.
const skillMix = (skills) => [
  ["yours", "Your skills", (s) => s.surface === "code" && !s.source.startsWith("plugin:"), "var(--c1)"],
  ["code", "Code plugins", (s) => s.surface === "code" && s.source.startsWith("plugin:"), "var(--c2)"],
  ["chatplug", "claude.ai plugins", (s) => s.surface === "chat" && s.source.startsWith("plugin:"), "var(--c3)"],
  ["anthropic", "Anthropic", (s) => s.surface === "chat" && s.source === "Anthropic", "var(--c4)"],
  ["chat", "Your claude.ai", (s) => s.surface === "chat" && !s.source.startsWith("plugin:") && s.source !== "Anthropic", "var(--c5)"],
].map(([key, label, test, color]) => ({ key, label, color, value: skills.filter(test).length }));

const MCP_GROUPS = [
  ["claude.ai", "Connectors", "var(--c1)", "On your claude.ai account. Chat, Cowork, routines and Code can use them."],
  ["chat", "claude.ai plugins", "var(--c2)", "Ship with claude.ai plugins and sync into Claude Code."],
  ["code", "Claude Code", "var(--c3)", "From your settings, projects and Code plugins."],
  ["app", "Desktop app", "var(--c4)", "Desktop extensions and claude_desktop_config.json."],
];
const mcpMix = (mcp) => MCP_GROUPS.map(([key, label, color]) => ({ key, label, color, value: mcp.filter((m) => m.surface === key).length }));

const FAMILIES = [["opus", "Opus", "var(--c1)"], ["sonnet", "Sonnet", "var(--c2)"], ["haiku", "Haiku", "var(--c3)"], ["fable", "Fable", "var(--c5)"]];
const modelMix = (models, field) => {
  const fam = (name) => (FAMILIES.find(([k]) => name.includes(k)) || ["other"])[0];
  return [...FAMILIES, ["other", "Other", "var(--c4)"]].map(([key, label, color]) => ({
    key, label, color, value: sum(models.filter((m) => fam(m.name) === key), field),
  }));
};

function HealthList({ items }) {
  const tone = { warning: "bad", caution: "warn", info: "info", ok: "ok" };
  const word = { warning: "Warning", caution: "Caution", info: "Note", ok: "OK" };
  return (
    <div className="checks">
      {items.map((h, i) => (
        <div className="check" key={i}>
          <Pill tone={tone[h.level] || "off"}>{word[h.level] || h.level}</Pill>
          <b>{h.title}</b>
          {h.detail && <p>{h.detail}</p>}
        </div>
      ))}
    </div>
  );
}

// ---------- Live sessions
const sessionState = (s) => (s.status === "busy" ? ["ok", "Working"]
  : /wait|input|permission/.test(s.status) ? ["warn", "Waiting for you"] : ["off", "Idle"]);

function NowBanner({ live }) {
  const running = (live && live.running) || [];
  if (!running.length) return null;
  const busy = running.filter((s) => s.status === "busy");
  const top = busy[0] || running[0];
  return (
    <a className="now" href="#live">
      <span className={`live-dot${busy.length ? "" : " idle"}`} aria-hidden="true" />
      <b>{busy.length ? `${plural(busy.length, "session")} working` : `${plural(running.length, "session")} open`}</b>
      <span className="now-what">{top.title} · {top.doing}</span>
    </a>
  );
}

function LiveBar({ ctl, live, now }) {
  const msg = {
    live: [<><span className="live-dot" aria-hidden="true" /> Live · updated {rel(live.at, now)}</>, null],
    prompt: ["Watch sessions as they happen. Live updates need full access: the app runs collect.py every 5 seconds and only reads.", ["Turn on live updates", ctl.enable]],
    denied: ["Live updates are turned off for this app.", ["Open permissions", ctl.manage]],
    install: ["Live updates run in the Claude Pit desktop app. This page shows the last snapshot.", ["Install as app", ctl.install]],
    error: [`Live update failed: ${ctl.error}`, ["Try again", ctl.enable]],
    snapshot: ["Live updates run in the Claude Pit desktop app. This page shows the last snapshot.", null],
  }[ctl.mode] || [null, null];
  return (
    <div className={`livebar ${ctl.mode}`}>
      <span>{msg[0]}</span>
      {msg[1] && <button type="button" className="btn" onClick={msg[1][1]}>{msg[1][0]}</button>}
    </div>
  );
}

function SessionCard({ s, now }) {
  const [tone, word] = sessionState(s);
  const kv = [["Project", s.project], ["Model", [model(s.model), s.effort && `${s.effort} effort`].filter(Boolean).join(" · ")],
    ["Started", s.started_at && `${fmt(s.started_at, T.full)} · ${rel(s.started_at, now)}`], ["Turns", s.turns || ""]];
  return (
    <article className="card">
      <div className="auto-h"><h2>{s.title}</h2><Pill tone={tone}>{word}</Pill>{s.app && <Tag>{s.app}</Tag>}</div>
      <div className="auto-body">
        <div className="session-now">
          <div className={`fnode doing ${tone === "ok" ? "focal" : "input"}`}>
            <span className="ftag">{tone === "ok" ? "Now" : "State"}</span>
            <b className="mono">{s.doing}</b>
            {s.status_since && <small>{word} for {rel(s.status_since, now).replace(" ago", "")}</small>}
          </div>
          {s.events.length > 0 && (
            <ol className="timeline">
              {s.events.map((e, i) => <li key={i} className={e.kind}><time>{fmt(e.t, T.time)}</time><span>{e.label}</span></li>)}
            </ol>
          )}
        </div>
        <div className="stack">
          {s.context && <Meter label="Context window" pct={(s.context.tokens / s.context.window) * 100}
            sub={`${compact(s.context.tokens)} of ${compact(s.context.window)} tokens`} />}
          <dl className="kv">{kv.filter(([, v]) => v).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
        </div>
      </div>
    </article>
  );
}

export function Live({ data, now, ctl }) {
  const live = data.live;
  const busy = live.running.filter((s) => s.status === "busy").length;
  return (
    <>
      <PageHead title="Live" sub={live.running.length ? `${plural(live.running.length, "session")} open · ${busy} working` : "No session open"} />
      <LiveBar ctl={ctl} live={live} now={now} />
      {live.running.length ? live.running.map((s) => <SessionCard key={s.id} s={s} now={now} />)
        : <Empty>No Claude Code session is running right now.</Empty>}
      <Card title="Recent sessions" meta="Claude desktop app">
        {live.recent.length ? (
          <div className="rows">
            {live.recent.map((r) => (
              <div className="row r2" key={r.id}>
                <div>
                  <span className="nm sans">{r.title}</span>
                  <div className="sub">{[r.project, model(r.model), r.turns && plural(r.turns, "turn")].filter(Boolean).join(" · ")}</div>
                </div>
                {r.running ? <Pill tone="ok">Open</Pill> : <span className="soft small mono">{rel(r.last_at, now)}</span>}
              </div>
            ))}
          </div>
        ) : <Empty>No sessions yet.</Empty>}
      </Card>
    </>
  );
}

// ---------- Monitor
export function Overview({ data, now }) {
  const next = upcomingRuns(data.automations, 60, now)[0];
  const c = data.cost, lim = data.live.limits;
  const [five, week] = lim ? lim.windows : [];
  const all = issues(data, now), look = needsLook(all);
  const by = (list, s) => list.filter((x) => x.surface === s).length;
  return (
    <>
      <PageHead title="Overview" sub={`Snapshot ${fmt(data.generated_at, T.full)} · ${rel(data.generated_at, now)}`} />
      <NowBanner live={data.live} />
      <div className="stats">
        <Stat href="#automations" label="Automations" value={data.automations.length} sub={`${data.automations.filter((a) => a.enabled).length} active`} />
        <Stat href="#usage" label="Cost · this month" value={usd(c.month)} sub={c.budget ? `${Math.round((c.month / c.budget) * 100)}% of ${usd(c.budget)}` : `today ${usd(c.today)}`} />
        <Stat href="#usage" label="5-hour limit" value={five ? `${five.percent}%` : "—"} sub={week ? `weekly ${week.percent}%` : "no plan data"} />
        <Stat href="#skills" label="Skills" value={data.skills.length} sub={`Code ${by(data.skills, "code")} · Chat ${by(data.skills, "chat")}`} />
        <Stat href="#mcp" label="MCP servers" value={data.mcp.length} sub={`${by(data.mcp, "claude.ai")} connectors`} />
      </div>
      <div className="grid g-next">
        {next ? (
          <a className="card next" href="#automations">
            <p className="eyebrow">Next run</p>
            <div className="next-time">{fmt(next.t, T.time)}</div>
            <div className="next-in">{fmt(next.t, T.day)} · {rel(next.t, now)}</div>
            <div className="next-name">{next.a.name}</div>
            <div className="next-sub">{next.a.where} · {next.a.schedule}</div>
          </a>
        ) : <Card title="Next run"><Empty>Nothing scheduled.</Empty></Card>}
        <Card title="Cost per day" meta="Last 14 days · API-equivalent">
          <Bars days={data.activity.days.slice(-14)} field="cost" format={usd} label="API-equivalent cost per day, last 14 days" />
        </Card>
      </div>
      <div className="grid g3">
        <Card title="Skills by source"><Donut items={skillMix(data.skills)} label="Skills by source" caption="skills" /></Card>
        <Card title="MCP by surface"><Donut items={mcpMix(data.mcp)} label="MCP servers by surface" caption="servers" /></Card>
        <Card title="Health" meta={look.length ? `${look.length} to check` : "All clear"}><HealthList items={all.slice(0, 4)} /></Card>
      </div>
    </>
  );
}

const KINDS = [["all", "All"], ["tool", "Tools"], ["prompt", "Prompts"], ["reply", "Replies"], ["error", "Errors"]];

export function Events({ data, now }) {
  const [kind, setKind] = useState("all");
  const [q, setQ] = useState("");
  const seen = new Set();
  const all = [...data.live.running.flatMap((s) => s.events.map((e) => ({ ...e, sid: s.id, session: s.title, project: s.project }))), ...data.events]
    .filter((e) => { const k = `${e.sid}|${e.t}|${e.label}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((x, y) => Date.parse(y.t) - Date.parse(x.t));
  const list = all.filter((e) => (kind === "all" || e.kind === kind) && matches(q, e.label, e.session, e.project));
  const groups = [];
  for (const e of list.slice(0, 250)) {
    const day = fmt(e.t, T.day), g = groups[groups.length - 1];
    if (g && g.day === day) g.items.push(e); else groups.push({ day, items: [e] });
  }
  const n = data.activity.event_counts || {};
  return (
    <>
      <PageHead title="Events" sub="Tool calls, prompts, replies and tool errors across all sessions, last 7 days" />
      <div className="stats s4">
        <Stat label="Tool calls" value={num(n.tool)} sub="7 days" />
        <Stat label="Prompts" value={num(n.prompt)} sub="7 days" />
        <Stat label="Replies" value={num(n.reply)} sub="7 days" />
        <Stat label="Tool errors" value={num(n.error)} sub="7 days" />
      </div>
      <div className="toolbar">
        <Search value={q} onChange={setQ} label="Search events" />
        <Seg value={kind} onChange={setKind} label="Show" options={KINDS} />
      </div>
      {groups.length ? groups.map((g) => (
        <Card key={g.day} title={g.day} meta={plural(g.items.length, "event")}>
          <ol className="stream">
            {g.items.map((e, i) => (
              <li key={i} className={e.kind}>
                <time>{fmt(e.t, T.time)}</time><i aria-hidden="true" />
                <span className="ev">{e.label}</span>
                <span className="ev-s">{e.session} · {e.project}</span>
              </li>
            ))}
          </ol>
        </Card>
      )) : <Empty>No events match.</Empty>}
      {list.length > 250 && <p className="hint">Showing the newest 250 of {list.length}.</p>}
    </>
  );
}

export function Automations({ data, now, ctl }) {
  const autos = data.automations;
  return (
    <>
      <PageHead title="Automations" sub={`${plural(autos.length, "automation")} · ${autos.filter((a) => a.enabled).length} active`} />
      {autos.length ? autos.map((a) => <AutoCard key={a.id} a={a} now={now} ctl={ctl} />)
        : <Empty>No automations yet. Type /schedule in Claude Code, or ask Cowork to run a task on a schedule.</Empty>}
    </>
  );
}

// Run, pause and resume go through Claude Code (/claude-pit), which holds the sign-in these actions need.
function Actions({ a, ctl }) {
  if (a.kind !== "cloud" && a.kind !== "desktop") return null;
  const go = (verb, what) => () => ctl.copy(`/claude-pit ${verb} ${a.id}`, `Paste it in Claude Code to ${what}.`);
  return (
    <div className="actions">
      <button type="button" className="btn" onClick={go("run", "run it now")}>Run now</button>
      <button type="button" className="btn" onClick={a.enabled ? go("pause", "pause it") : go("resume", "resume it")}>{a.enabled ? "Pause" : "Resume"}</button>
    </div>
  );
}

function AutoCard({ a, now, ctl }) {
  const [tone, word] = status(a);
  const conn = a.connectors.map((c) => c.replace(/_/g, " "));
  const dot = { succeeded: "ok", failed: "bad", running: "info" };
  return (
    <article className="card">
      <div className="auto-h"><h2>{a.name}</h2><Pill tone={tone}>{word}</Pill><Tag>{a.origin}</Tag><Actions a={a} ctl={ctl} /></div>
      <div className="auto-body">
        <Flow a={a} />
        <dl className="kv">
          <dt>Schedule</dt>
          <dd>{a.schedule}{a.cron && <div className="mono soft small">{a.cron}</div>}</dd>
          <dt>Next run</dt>
          <dd>{a.enabled && a.next_run_at ? <>{fmt(a.next_run_at, T.full)} <span className="soft">· {rel(a.next_run_at, now)}</span></> : "—"}</dd>
          <dt>Last runs</dt>
          <dd>
            {a.runs.length ? (
              <div className="runs">
                {a.runs.map((r, i) => (
                  <div className="run" key={i}>
                    <i className={dot[r.status] || ""} />
                    <span>{fmt(r.started_at, T.full)}</span>
                    <span className="soft">{r.status}</span>
                    {r.url && <a href={r.url} target="_blank" rel="noopener" className="link">Open</a>}
                  </div>
                ))}
              </div>
            ) : <span className="soft">No runs yet</span>}
          </dd>
          {a.model && <><dt>Model</dt><dd>{model(a.model)}</dd></>}
          {a.permission_mode && <><dt>Permissions</dt><dd>{a.permission_mode}</dd></>}
          <dt>Result</dt><dd>{result(a)}</dd>
          {conn.length > 0 && <><dt>Connectors</dt><dd><div className="chips">{conn.map((c) => <span className="chip" key={c}>{c}</span>)}</div></dd></>}
          {a.command && <><dt>Command</dt><dd className="mono small">{a.command}</dd></>}
          {a.created_at && <><dt>Created</dt><dd>{fmt(a.created_at, T.date)}</dd></>}
          {a.problem && <><dt>Problem</dt><dd className="bad">{a.problem}</dd></>}
        </dl>
      </div>
      {a.prompt && <details className="prompt"><summary>Prompt</summary><pre>{a.prompt}</pre></details>}
    </article>
  );
}

export function Schedule({ data, now }) {
  const runs = upcomingRuns(data.automations, 7, now);
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start); d.setDate(start.getDate() + i);
    const end = new Date(d); end.setDate(d.getDate() + 1);
    return { d, i, runs: runs.filter((r) => r.t >= d.getTime() && r.t < end.getTime()) };
  });
  const dayName = (i, d) => (i === 0 ? "Today" : i === 1 ? "Tomorrow" : fmt(d.getTime(), { weekday: "short" }));
  return (
    <>
      <PageHead title="Schedule" sub={`${plural(runs.length, "run")} in the next 7 days`} />
      <div className="week">
        {days.map(({ d, i, runs: rs }) => (
          <div key={i} className={`day${i === 0 ? " today" : ""}`}>
            <span className="eyebrow">{i === 0 ? "Today" : fmt(d.getTime(), { weekday: "short" })}</span>
            <b>{d.getDate()}</b>
            <div className="dots">{rs.slice(0, 4).map((_, j) => <i key={j} />)}</div>
            <small>{rs.length ? plural(rs.length, "run") : "free"}</small>
          </div>
        ))}
      </div>
      {days.filter((x) => x.runs.length).map(({ d, i, runs: rs }) => (
        <section className="agenda" key={i}>
          <p className="eyebrow">{dayName(i, d)} · {fmt(d.getTime(), T.short)}</p>
          {rs.map(({ a, t }) => (
            <MiniFlow key={a.id + t} label={`${fmt(t, T.time)} ${a.name}`} nodes={[
              { kind: "input time", tag: "Time", name: fmt(t, T.time), sub: rel(t, now), mono: true },
              { tag: "Run", name: a.name, sub: a.where },
              { kind: "plain", tag: "Does", name: a.steps.slice(0, 3).map((s) => s.label).join(" · ") + (a.steps.length > 3 ? " …" : ""), sub: plural(a.steps.length, "step") },
              { kind: "focal", tag: "Out", name: result(a) },
            ]} />
          ))}
        </section>
      ))}
      {!runs.length && <Empty>No runs in the next 7 days.</Empty>}
    </>
  );
}

// ---------- Insights
export function Usage({ data, now }) {
  const a = data.activity, c = data.cost, lim = data.live.limits;
  const top = [...data.history].sort((x, y) => y.cost - x.cost).slice(0, 8)
    .map((h) => ({ label: h.title, value: h.cost, title: `${h.title} · ${h.project} · ${fmt(h.last, T.date)}` }));
  return (
    <>
      <PageHead title="Usage & cost" sub={`Claude Code on this computer · last ${a.window} days`} />
      <div className="grid g-next">
        <Card title="Plan limits" meta={lim ? `${lim.plan || "Plan"} · ${rel(lim.at, now)}` : ""}>
          {lim ? <div className="stack">{lim.windows.map((w) => (
            <Meter key={w.label} label={w.label} pct={w.percent} sub={w.resets_at ? `Resets ${rel(w.resets_at, now)}` : "Reset time not known"} />
          ))}</div> : <Empty>No plan data yet. Type /claude-pit in Claude Code.</Empty>}
        </Card>
        <div className="stack">
          <div className="stats s3">
            <Stat label="Today" value={usd(c.today)} sub="API-equivalent" />
            <Stat label="This month" value={usd(c.month)} sub={c.budget ? `of ${usd(c.budget)} budget` : "no budget set"} />
            <Stat label={`Last ${a.window} days`} value={usd(c.window)} sub={`${compact(sum(a.days, "output_tokens"))} output tokens`} />
          </div>
          {c.budget ? <Card><Meter label="Monthly budget" pct={(c.month / c.budget) * 100} sub={`${usd(c.month)} of ${usd(c.budget)} · alerts at 80% and 100%`} /></Card>
            : <a className="now" href="#settings"><b>Set a monthly budget</b><span className="now-what">Get an alert when this month's cost passes it</span></a>}
        </div>
      </div>
      <div className="grid g-wide">
        <Card title="Cost per day" meta="USD"><Bars days={a.days} field="cost" format={usd} label="API-equivalent cost per day" /></Card>
        <Card title="Cost by model"><Donut items={modelMix(a.models, "cost")} label="Cost by model" caption="USD" format={usd} /></Card>
      </div>
      <div className="grid g2">
        <Card title="Most expensive sessions" meta="all time">{top.length ? <HBars items={top} format={usd} /> : <Empty>No sessions yet.</Empty>}</Card>
        <Card title="Top tools" meta={`${a.window} days`}>{a.tools && a.tools.length ? <HBars items={a.tools.map((t) => ({ label: t.name, value: t.count }))} /> : <Empty>No tool calls yet.</Empty>}</Card>
      </div>
      <div className="grid g-wide">
        <Card title="Sessions per day"><Bars days={a.days} field="sessions" label="Sessions per day" /></Card>
        <Card title="Output tokens by model"><Donut items={modelMix(a.models, "output_tokens")} label="Output tokens by model" caption="tokens" /></Card>
      </div>
      <div className="grid g2">
        <Card title="Top projects" meta="sessions">{a.projects.length ? <HBars items={a.projects.map((p) => ({ label: p.name, value: p.sessions }))} /> : <Empty>No sessions yet.</Empty>}</Card>
        <Card title="Most used skills" meta="uses">{a.skills_used.length ? <HBars items={a.skills_used.slice(0, 8).map((s) => ({ label: s.name, value: s.count }))} /> : <Empty>No skill use recorded.</Empty>}</Card>
      </div>
      <p className="fine">Cost is what the same tokens would cost at Anthropic API list prices, including cache writes and reads. {lim && lim.plan ? `Your ${lim.plan} plan is a fixed monthly price, so this is a gauge of use, not a bill.` : ""}</p>
    </>
  );
}

export function History({ data, now, ctl }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("last");
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const list = data.history.filter((h) => matches(q, h.title, h.project, h.app, model(h.model)))
    .sort((a, b) => (sort === "cost" ? b.cost - a.cost : sort === "replies" ? b.replies - a.replies : Date.parse(b.last) - Date.parse(a.last)));
  const deep = () => {
    setBusy(true); setErr("");
    ctl.search(q).then(setFound).catch((e) => setErr(e.message || String(e))).finally(() => setBusy(false));
  };
  return (
    <>
      <PageHead title="History" sub={`${plural(data.history.length, "session")} · ${usd(sum(data.history, "cost"))} API-equivalent`} />
      <div className="toolbar">
        <Search value={q} onChange={(v) => { setQ(v); setFound(null); }} label="Search sessions" />
        <Seg value={sort} onChange={setSort} label="Sort" options={[["last", "Recent"], ["cost", "Cost"], ["replies", "Replies"]]} />
        {ctl.full && <button type="button" className="btn" disabled={busy || q.trim().length < 2} onClick={deep}>{busy ? "Searching…" : "Search inside messages"}</button>}
      </div>
      {!ctl.full && <p className="hint">Search inside messages works in the Claude Pit desktop app with live updates on. Here it searches titles and projects.</p>}
      {err && <p className="hint bad">{err}</p>}
      {found && (
        <Card title={`“${q}” in messages`} meta={plural(found.length, "session")}>
          {found.length ? (
            <div className="rows">
              {found.map((h) => (
                <div className="row r2" key={h.id}>
                  <div>
                    <span className="nm sans">{h.title}</span>
                    <div className="sub">{h.project} · {rel(h.last, now)} · {h.matches} {h.matches === 1 ? "match" : "matches"}</div>
                    {h.snippets.map((s, i) => <p className="snippet" key={i}><b>{s.who === "you" ? "You" : "Claude"}</b> {s.text}</p>)}
                  </div>
                </div>
              ))}
            </div>
          ) : <Empty>Nothing found.</Empty>}
        </Card>
      )}
      <Card>
        {list.length ? (
          <div className="rows">
            {list.map((h) => (
              <div className="row hist" key={h.id}>
                <div>
                  <span className="nm sans">{h.title}</span>
                  <div className="sub">{[h.project, h.app, model(h.model), `${fmt(h.started, T.short)} – ${rel(h.last, now)}`].filter(Boolean).join(" · ")}</div>
                </div>
                <span className="mono small soft">{h.replies} {h.replies === 1 ? "reply" : "replies"} · {plural(h.tools, "tool")}</span>
                <b className="mono">{usd(h.cost)}</b>
              </div>
            ))}
          </div>
        ) : <Empty>No sessions match.</Empty>}
      </Card>
    </>
  );
}

// ---------- Library
export function Skills({ data }) {
  const [q, setQ] = useState("");
  const [surface, setSurface] = useState("all");
  const list = data.skills.filter((s) => (surface === "all" || s.surface === surface) && matches(q, s.name, s.description, s.source));
  const by = (s) => data.skills.filter((x) => x.surface === s).length;
  return (
    <>
      <PageHead title="Skills" sub={`Code ${by("code")} · Chat ${by("chat")}`} />
      <Card title="By source"><Donut items={skillMix(data.skills)} label="Skills by source" caption="skills" /></Card>
      <div className="toolbar">
        <Search value={q} onChange={setQ} label="Search skills" />
        <Seg value={surface} onChange={setSurface} label="Show" options={[["all", "All"], ["code", "Claude Code"], ["chat", "Claude Chat"]]} />
      </div>
      {list.length ? (
        <ul className="items">
          {list.map((s, i) => (
            <li className="item" key={s.source + s.name + i}>
              <div className="item-h"><b className="mono">{s.name}</b><Tag>{source(s.source)}</Tag></div>
              {s.description && <p title={s.description}>{s.description}</p>}
            </li>
          ))}
        </ul>
      ) : <Empty>No skills match.</Empty>}
    </>
  );
}

export function Plugins({ data }) {
  const rows = (list) => (
    <div className="rows">
      {list.map((p) => (
        <div className="row" key={p.name}>
          <div title={p.description}>
            <span className="nm">{p.name}</span>
            <div className="sub">{[p.version && `v${p.version}`, p.marketplace].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="chips counts">
            {[["skills", "skills"], ["commands", "commands"], ["agents", "agents"], ["hooks", "hooks"], ["mcp", "MCP"]]
              .filter(([k]) => p.counts[k]).map(([k, w]) => <span className="chip" key={k}>{p.counts[k]} {w}</span>)}
          </div>
          <Pill tone={p.enabled ? "ok" : "off"}>{p.enabled ? "On" : "Off"}</Pill>
        </div>
      ))}
    </div>
  );
  const code = data.plugins.filter((p) => p.surface === "code"), chat = data.plugins.filter((p) => p.surface === "chat");
  return (
    <>
      <PageHead title="Plugins" sub={`Code ${code.length} · Chat ${chat.length}`} />
      <Card title="Claude Code" meta="/plugin">{code.length ? rows(code) : <Empty>None installed.</Empty>}</Card>
      <Card title="Claude Chat" meta="claude.ai · syncs to Code">{chat.length ? rows(chat) : <Empty>None turned on.</Empty>}</Card>
    </>
  );
}

export function Mcp({ data }) {
  const tone = { "needs sign-in": "warn", enabled: "ok", disabled: "off" };
  return (
    <>
      <PageHead title="MCP" sub={`${plural(data.mcp.length, "server")} and connectors`} />
      <Card title="By surface"><Donut items={mcpMix(data.mcp)} label="MCP servers by surface" caption="servers" /></Card>
      <div className="grid g2">
        {MCP_GROUPS.map(([key, label, , note]) => {
          const list = data.mcp.filter((m) => m.surface === key);
          return list.length ? (
            <Card key={key} title={label} meta={list.length}>
              <p className="soft small note">{note}</p>
              <div className="rows">
                {list.map((m, i) => (
                  <div className="row r2" key={m.name + m.scope + i}>
                    <div>
                      <span className="nm sans">{m.name}</span>
                      <div className="sub">{[m.scope !== "connector" && source(m.scope), m.transport, m.host].filter(Boolean).join(" · ")}</div>
                    </div>
                    {m.status ? <Pill tone={tone[m.status] || "off"}>{m.status === "needs sign-in" ? "Sign in" : m.status}</Pill> : <span />}
                  </div>
                ))}
              </div>
            </Card>
          ) : null;
        })}
      </div>
    </>
  );
}

export function Agents({ data }) {
  const [q, setQ] = useState("");
  const agents = data.agents.filter((a) => matches(q, a.name, a.description, a.source));
  const commands = data.commands.filter((c) => matches(q, c.name, c.description, c.source));
  return (
    <>
      <PageHead title="Agents" sub={`${plural(data.agents.length, "agent")} · ${plural(data.commands.length, "slash command")}`} />
      <div className="toolbar"><Search value={q} onChange={setQ} label="Search agents and commands" /></div>
      {commands.length > 0 && (
        <Card title="Slash commands" meta={commands.length}>
          <div className="rows">
            {commands.map((c, i) => (
              <div className="row cmd" key={c.source + c.name + i}>
                <span className="nm">/{c.name}</span><span className="sub">{c.description}</span><Tag>{source(c.source)}</Tag>
              </div>
            ))}
          </div>
        </Card>
      )}
      {agents.length ? (
        <ul className="items">
          {agents.map((a, i) => (
            <li className="item" key={a.source + a.name + i}>
              <div className="item-h"><b>{a.name}</b><Tag>{source(a.source)}</Tag></div>
              {a.description && <p title={a.description}>{a.description}</p>}
            </li>
          ))}
        </ul>
      ) : <Empty>No agents match.</Empty>}
    </>
  );
}

const EVENTS = {
  SessionStart: "Session starts", SessionEnd: "Session ends", UserPromptSubmit: "Every prompt", PreToolUse: "Before a tool",
  PostToolUse: "After a tool", Stop: "Reply finished", SubagentStart: "Subagent starts", SubagentStop: "Subagent ends",
  Notification: "Notification", PreCompact: "Before compact",
};

export function Hooks({ data }) {
  const groups = [...new Set(data.hooks.map((h) => h.source))];
  return (
    <>
      <PageHead title="Hooks" sub="Commands Claude Code runs by itself on an event" />
      {groups.length ? groups.map((g) => (
        <Card key={g} title={source(g)} meta={plural(data.hooks.filter((h) => h.source === g).length, "hook")}>
          <div className="agenda">
            {data.hooks.filter((h) => h.source === g).map((h, i) => (
              <MiniFlow key={i} label={`${h.event} runs ${h.command}`} nodes={[
                { kind: "input", tag: "Event", name: h.event, sub: EVENTS[h.event] || "" },
                { kind: "plain", tag: "Match", name: h.matcher || "Any", mono: true },
                { tag: "Run", name: h.command, mono: true },
              ]} />
            ))}
          </div>
        </Card>
      )) : <Empty>No hooks.</Empty>}
    </>
  );
}

export function Memory({ data, ctl }) {
  const [sel, setSel] = useState(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const open = (m) => {
    setSel(m); setText(""); setErr("");
    if (!ctl.full) { setErr("Reading files works in the Claude Pit desktop app with live updates on."); return; }
    ctl.readFile(m.path).then((t) => setText(t || "(empty file)")).catch((e) => setErr(e.message || String(e)));
  };
  const groups = [["user", "Your CLAUDE.md", "Read in every session"], ["project", "Project CLAUDE.md", "Read in sessions inside that folder"],
    ["memory", "Auto memory", "Notes Claude keeps between sessions"]];
  return (
    <>
      <PageHead title="Memory" sub={`${plural(data.memory.length, "file")} Claude reads when a session starts`} />
      <div className="grid g-memo">
        <div className="stack">
          {groups.map(([k, label, note]) => {
            const list = data.memory.filter((m) => m.scope === k);
            return list.length ? (
              <Card key={k} title={label} meta={note}>
                <div className="rows">
                  {list.map((m) => (
                    <button type="button" key={m.path} className={`row pick${sel && sel.path === m.path ? " on" : ""}`} onClick={() => open(m)}>
                      <div>
                        <span className="nm">{m.name}</span>
                        <div className="sub">{m.description}</div>
                      </div>
                      <span className="soft small mono">{m.project} · {(m.size / 1024).toFixed(1)} KB</span>
                    </button>
                  ))}
                </div>
              </Card>
            ) : null;
          })}
          {!data.memory.length && <Empty>No CLAUDE.md or memory files found.</Empty>}
        </div>
        <Card className="viewer" title={sel ? sel.name : "Pick a file"} meta={sel ? sel.path : ""}>
          {text ? <pre className="file">{text}</pre> : <p className="soft">{err || (sel ? "Loading…" : "Choose a file to read it here.")}</p>}
        </Card>
      </div>
    </>
  );
}

// ---------- System
export function Health({ data, now }) {
  const all = issues(data, now), look = needsLook(all);
  return (
    <>
      <PageHead title="Health" sub={look.length ? `${plural(look.length, "item")} to check` : "Nothing needs attention"} />
      <Card><HealthList items={all} /></Card>
    </>
  );
}

export function Settings({ data, now, ctl }) {
  const [budget, setBudget] = useState(data.cost.budget || "");
  const [msg, setMsg] = useState("");
  const refresh = data.automations.find((a) => a.id === "desktop:claude-pit-refresh");
  const save = () => {
    const n = Number(budget || 0);
    if (!(n >= 0)) { setMsg("Enter an amount in dollars, or 0 to turn the budget off."); return; }
    if (ctl.full) ctl.saveBudget(n).then(() => setMsg(n ? `Saved. Alerts at 80% and 100% of ${usd(n)}.` : "Budget turned off.")).catch((e) => setMsg(e.message || String(e)));
    else ctl.copy(`/claude-pit budget ${n}`, "Paste it in Claude Code to save the budget.");
  };
  const app = ctl.mode !== "snapshot" && ctl.mode !== "install";
  const perm = (name) => ctl.perms[name] || "unavailable";
  return (
    <>
      <PageHead title="Settings" />
      <Card title="Monthly budget" meta="API-equivalent USD">
        <form className="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <label htmlFor="budget">Alert me when this month's cost passes</label>
          <div className="inline">
            <span className="prefix">$</span>
            <input id="budget" type="number" min="0" step="1" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button type="submit" className="btn">{ctl.full ? "Save" : "Copy command"}</button>
          </div>
          <p className="hint">{msg || `This month so far: ${usd(data.cost.month)}. Alerts show in Health, as a notification in the desktop app, and as a push from the scheduled refresh.`}</p>
        </form>
      </Card>
      <Card title="Desktop app" meta={app ? "Claude Pit app" : "Install to use these"}>
        <div className="rows">
          <div className="row r2">
            <div><span className="nm sans">Live updates</span><div className="sub">Follow sessions every 5 seconds. Needs full access; only reads.</div></div>
            {ctl.mode === "live" ? <Pill tone="ok">On</Pill> : app ? <button type="button" className="btn" onClick={ctl.enable}>Turn on</button> : <Pill tone="off">App only</Pill>}
          </div>
          <div className="row r2">
            <div><span className="nm sans">Menu bar</span><div className="sub">Working sessions, next run, cost and limits at the top of your screen.</div></div>
            {app ? <button type="button" className="btn" aria-pressed={ctl.trayOn} onClick={ctl.toggleTray}>{ctl.trayOn ? "Turn off" : "Turn on"}</button> : <Pill tone="off">App only</Pill>}
          </div>
          <div className="row r2">
            <div><span className="nm sans">Notifications</span><div className="sub">When a session finishes or needs you, a run fails, or the budget is passed.</div></div>
            {perm("notifications") === "granted" ? <Pill tone="ok">On</Pill> : app ? <button type="button" className="btn" onClick={ctl.enableNotify}>Turn on</button> : <Pill tone="off">App only</Pill>}
          </div>
        </div>
        {ctl.mode === "install" && <button type="button" className="btn" onClick={ctl.install}>Install as app</button>}
      </Card>
      <Card title="Refresh">
        <p className="hint">
          {refresh ? `${refresh.name} runs ${refresh.schedule.toLowerCase()}` : "No refresh task found"}. Type <code>/claude-pit</code> in Claude Code to refresh now.
          Last snapshot {fmt(data.generated_at, T.full)} ({rel(data.generated_at, now)}).
        </p>
        <button type="button" className="btn" onClick={() => ctl.copy("/claude-pit", "Paste it in Claude Code to refresh now.")}>Copy refresh command</button>
      </Card>
    </>
  );
}
