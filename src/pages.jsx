// One component per sidebar page. Each gets the whole snapshot (`data`) and the current time (`now`).
import {
  PageHead, Card, Stat, Pill, Tag, Empty, Search, Seg, Donut, Bars, HBars, Flow, MiniFlow,
  fmt, rel, T, num, compact, plural, sum, matches, source, model, upcomingRuns, issues, needsLook, status, result,
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
const modelMix = (models) => {
  const fam = (name) => (FAMILIES.find(([k]) => name.includes(k)) || ["other"])[0];
  return [...FAMILIES, ["other", "Other", "var(--c4)"]].map(([key, label, color]) => ({
    key, label, color, value: sum(models.filter((m) => fam(m.name) === key), "output_tokens"),
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
    prompt: ["Watch sessions as they happen. Live updates need full access: the app runs collect.py --live every 5 seconds and only reads.", ["Turn on live updates", ctl.enable]],
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
              {s.events.map((e, i) => (
                <li key={i} className={e.kind}><time>{fmt(e.t, T.time)}</time><span>{e.label}</span></li>
              ))}
            </ol>
          )}
        </div>
        <dl className="kv">{kv.filter(([, v]) => v).map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl>
      </div>
    </article>
  );
}

export function Live({ data, now, ctl }) {
  const live = data.live || { at: data.generated_at, running: [], recent: [] };
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
              <div className="row" key={r.id} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
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
  const act = data.activity;
  const all = issues(data, now), look = needsLook(all);
  const by = (list, s) => list.filter((x) => x.surface === s).length;
  return (
    <>
      <PageHead title="Overview" sub={`Snapshot ${fmt(data.generated_at, T.full)} · ${rel(data.generated_at, now)}`} />
      <NowBanner live={data.live} />
      <div className="stats">
        <Stat href="#automations" label="Automations" value={data.automations.length} sub={`${data.automations.filter((a) => a.enabled).length} active`} />
        <Stat href="#skills" label="Skills" value={data.skills.length} sub={`Code ${by(data.skills, "code")} · Chat ${by(data.skills, "chat")}`} />
        <Stat href="#plugins" label="Plugins" value={data.plugins.length} sub={`Code ${by(data.plugins, "code")} · Chat ${by(data.plugins, "chat")}`} />
        <Stat href="#mcp" label="MCP servers" value={data.mcp.length} sub={`${by(data.mcp, "claude.ai")} connectors`} />
        <Stat href="#activity" label="Sessions · 30 days" value={act.totals.window_sessions || 0} sub={`${act.totals.active_days} active days`} />
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
        ) : (
          <Card title="Next run"><Empty>Nothing scheduled.</Empty></Card>
        )}
        <Card title="Sessions" meta="Last 14 days"><Bars days={act.days.slice(-14)} field="sessions" label="Claude Code sessions per day, last 14 days" /></Card>
      </div>
      <div className="grid g3">
        <Card title="Skills by source"><Donut items={skillMix(data.skills)} label="Skills by source" caption="skills" /></Card>
        <Card title="MCP by surface"><Donut items={mcpMix(data.mcp)} label="MCP servers by surface" caption="servers" /></Card>
        <Card title="Health" meta={look.length ? `${look.length} to check` : "All clear"}><HealthList items={all.slice(0, 4)} /></Card>
      </div>
    </>
  );
}

export function Automations({ data, now }) {
  const autos = data.automations;
  return (
    <>
      <PageHead title="Automations" sub={`${plural(autos.length, "automation")} · ${autos.filter((a) => a.enabled).length} active`} />
      {autos.length ? autos.map((a) => <AutoCard key={a.id} a={a} now={now} />)
        : <Empty>No automations yet. Type /schedule in Claude Code, or ask Cowork to run a task on a schedule.</Empty>}
    </>
  );
}

function AutoCard({ a, now }) {
  const [tone, word] = status(a);
  const conn = a.connectors.map((c) => c.replace(/_/g, " "));
  const dot = { succeeded: "ok", failed: "bad", running: "info" };
  return (
    <article className="card">
      <div className="auto-h"><h2>{a.name}</h2><Pill tone={tone}>{word}</Pill><Tag>{a.origin}</Tag></div>
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
                    {r.url && <a href={r.url} target="_blank" rel="noopener" style={{ color: "var(--link)" }}>Open</a>}
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

export function Activity({ data }) {
  const act = data.activity, d = act.days;
  const projects = act.projects.map((p) => ({ label: p.name, value: p.sessions, title: `${p.name}: last active ${fmt(p.last, T.full)}` }));
  const skills = act.skills_used.slice(0, 8).map((s) => ({ label: s.name, value: s.count, title: `${s.name}: last used ${fmt(s.last, T.full)}` }));
  return (
    <>
      <PageHead title="Activity" sub={`Claude Code on this computer · last ${act.window} days`} />
      <div className="stats s4">
        <Stat label="Sessions" value={num(act.totals.window_sessions || 0)} sub={`${num(act.totals.sessions)} all time`} />
        <Stat label="Replies" value={compact(sum(d, "messages"))} sub={`${compact(act.totals.messages)} all time`} />
        <Stat label="Output tokens" value={compact(sum(d, "output_tokens"))} sub={`${compact(sum(d, "input_tokens"))} input`} />
        <Stat label="Active days" value={act.totals.active_days} sub={`of ${act.window}`} />
      </div>
      <div className="grid g-wide">
        <Card title="Sessions per day"><Bars days={d} field="sessions" label="Sessions per day" /></Card>
        <Card title="Output tokens by model"><Donut items={modelMix(act.models)} label="Output tokens by model" caption="tokens" /></Card>
      </div>
      <Card title="Output tokens per day"><Bars days={d} field="output_tokens" label="Output tokens per day" format={compact} /></Card>
      <div className="grid g2">
        <Card title="Top projects" meta="sessions">{projects.length ? <HBars items={projects} /> : <Empty>No sessions yet.</Empty>}</Card>
        <Card title="Most used skills" meta="uses">{skills.length ? <HBars items={skills} /> : <Empty>No skill use recorded.</Empty>}</Card>
      </div>
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
              <p className="soft small" style={{ margin: "-8px 0 14px" }}>{note}</p>
              <div className="rows">
                {list.map((m, i) => (
                  <div className="row" key={m.name + m.scope + i} style={{ gridTemplateColumns: "minmax(0,1fr) auto" }}>
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
              <div className="row" key={c.source + c.name + i} style={{ gridTemplateColumns: "minmax(0,14rem) minmax(0,1fr) auto" }}>
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
