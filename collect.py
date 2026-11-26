#!/usr/bin/env python3
"""Claude Pit: a dashboard of your whole Claude setup.

Schedules and routines, activity, event hooks, plugins, MCP servers and
connectors, skills, agents and slash commands, for Claude Code and claude.ai.

    python3 collect.py                    rebuild out/ from local config + cached cloud data
    python3 collect.py --routines FILE    also import a RemoteTrigger `list` result
    python3 collect.py --selftest         run the built-in checks

Standard library only, Python 3.9+. The React app in src/ is prebuilt into
build/ (npm run build). Env vars, headers, URL paths, command arguments and
tokens are never copied into the output.
"""
import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import plistlib
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

HOME = Path.home()
CLAUDE = HOME / ".claude"
APP = HOME / "Library" / "Application Support" / "Claude"  # Claude desktop app (macOS)
ROOT = Path(__file__).resolve().parent
CACHE, OUT, BUILD = ROOT / "cache", ROOT / "out", ROOT / "build"
NOW = dt.datetime.now(dt.timezone.utc)


# ---------------------------------------------------------------- helpers

def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def clip(text, n=200):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


TOKENISH = re.compile(r"[A-Za-z0-9_\-+=]{32,}")


def redact(text, n=160):
    """Shorten a command line, hide the home folder and blank anything that looks like a key."""
    return clip(TOKENISH.sub("•••", str(text or "").replace(str(HOME), "~")), n)


def norm(name):
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def frontmatter(path):
    """Top-level `key: value` pairs of a Markdown file's YAML header (folded values joined)."""
    try:
        text = Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    meta, key = {}, None
    for line in text[3:max(end, 0)].splitlines():
        m = re.match(r"([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            meta[key] = "" if val in (">", "|", ">-", "|-") else val.strip("\"'")
        elif key and line[:1] in (" ", "\t"):
            meta[key] = (meta[key] + " " + line.strip()).strip()
    return meta


def md_items(paths, source, kind, n=180):
    """Skills (folders holding SKILL.md) or agents/commands (*.md files) under the given paths."""
    out = []
    for base in map(Path, paths):
        if kind == "skill":
            files = sorted(base.glob("*/SKILL.md")) if base.is_dir() else []
        else:
            files = [base] if base.is_file() else sorted(base.glob("*.md")) if base.is_dir() else []
        for f in files:
            meta = frontmatter(f)
            out.append({"name": meta.get("name") or (f.parent.name if kind == "skill" else f.stem),
                        "description": clip(meta.get("description"), n), "source": source})
    return out


def hook_rows(hooks, source):
    rows = []
    for event, groups in (hooks or {}).items() if isinstance(hooks, dict) else []:
        for g in groups if isinstance(groups, list) else []:
            for h in g.get("hooks") or [] if isinstance(g, dict) else []:
                rows.append({"event": event, "matcher": g.get("matcher") or "",
                             "command": redact(h.get("command") or h.get("prompt") or h.get("url") or h.get("type")),
                             "source": source})
    return rows


def mcp_rows(servers, scope, needs, prefix=""):
    """Name, transport and host only: commands, args, env and headers can hold secrets."""
    if not isinstance(servers, dict):
        return []
    rows = []
    for name, c in servers.items():
        c = c if isinstance(c, dict) else {}
        host = urlparse(str(c.get("url") or "")).hostname or ""
        rows.append({"name": name, "scope": scope, "host": host,
                     "transport": c.get("type") or ("stdio" if c.get("command") else "http" if host else ""),
                     "status": "needs sign-in" if prefix + name in needs else ""})
    return rows


def needs_signin():
    """Servers Claude Code's last check found waiting for sign-in."""
    cache = load_json(CLAUDE / "mcp-needs-auth-cache.json", {}) or {}
    stamps = {k: v.get("timestamp", 0) for k, v in cache.items() if isinstance(v, dict)}
    newest = max(stamps.values(), default=0)
    # ponytail: only entries from the latest check (within 1 h of the newest) count, older ones are
    # usually fixed since. Exact state needs a live MCP handshake; add one if this misleads.
    return {k for k, t in stamps.items() if newest - t <= 3_600_000}


# ---------------------------------------------------------------- cron

MONTHS = {m: i for i, m in enumerate("jan feb mar apr may jun jul aug sep oct nov dec".split(), 1)}
DAYS = {d: i for i, d in enumerate("sun mon tue wed thu fri sat".split())}
DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
MACROS = {"@yearly": "0 0 1 1 *", "@annually": "0 0 1 1 *", "@monthly": "0 0 1 * *",
          "@weekly": "0 0 * * 0", "@daily": "0 0 * * *", "@midnight": "0 0 * * *", "@hourly": "0 * * * *"}


def parse_field(spec, lo, hi, names=None):
    vals = set()
    for part in spec.lower().split(","):
        rng, _, step = part.partition("/")
        num = lambda s: names[s] if names and s in names else int(s)  # noqa: E731
        if rng in ("*", "?"):
            a, b = lo, hi
        elif "-" in rng:
            a, b = (num(x) for x in rng.split("-", 1))
        else:
            a = num(rng)
            b = hi if step else a
        if not lo <= a <= b <= hi:
            raise ValueError("out of range: " + spec)
        vals.update(range(a, b + 1, int(step or 1)))
    return vals


def parse_cron(expr, tz=None):
    """'[CRON_TZ=Area/City] m h dom mon dow' -> (value sets, zone name)."""
    expr = (expr or "").strip()
    m = re.match(r"(?:CRON_)?TZ=(\S+)\s+(.*)", expr)
    if m:
        tz, expr = m.group(1), m.group(2).strip()
    f = MACROS.get(expr.lower(), expr).split()
    if len(f) != 5:
        raise ValueError("cron needs 5 fields: " + expr)
    return {"min": parse_field(f[0], 0, 59), "hour": parse_field(f[1], 0, 23),
            "dom": parse_field(f[2], 1, 31), "mon": parse_field(f[3], 1, 12, MONTHS),
            "dow": {d % 7 for d in parse_field(f[4], 0, 7, DAYS)},
            "dom_any": f[2] in ("*", "?"), "dow_any": f[4] in ("*", "?"), "fields": f}, tz or "UTC"


def upcoming(expr, now, days=14, limit=40, tz=None):
    """Next run times (UTC) within `days`, with cron's day-of-month OR day-of-week rule."""
    c, zone = parse_cron(expr, tz)
    z = ZoneInfo(zone)
    local, out = now.astimezone(z), []
    for i in range(days + 1):
        d = local.date() + dt.timedelta(days=i)
        dom, dow = d.day in c["dom"], d.isoweekday() % 7 in c["dow"]
        day_ok = (dom and dow) if c["dom_any"] or c["dow_any"] else (dom or dow)
        if d.month not in c["mon"] or not day_ok:
            continue
        for h in sorted(c["hour"]):
            for mi in sorted(c["min"]):
                t = dt.datetime(d.year, d.month, d.day, h, mi, tzinfo=z)
                if t > local:
                    out.append(t.astimezone(dt.timezone.utc))
                    if len(out) >= limit:
                        return out
    return out


def describe(expr):
    """Plain-English text for common cron shapes; anything else stays as cron."""
    c, _ = parse_cron(expr)
    mi, hr, dom, mon, dow = c["fields"]
    raw = "Cron " + " ".join(c["fields"])
    if mon != "*":
        return raw
    if hr == "*" and dom == dow == "*":
        if mi == "*":
            return "Every minute"
        if mi.startswith("*/"):
            return "Every %s minutes" % mi[2:]
        if mi.isdigit():
            return "Every hour at :%02d" % int(mi)
    if not (re.fullmatch(r"\d+(,\d+)*", mi) and re.fullmatch(r"\d+(,\d+)*", hr)):
        return raw
    times = ", ".join("%02d:%02d" % (h, m) for h in sorted(c["hour"]) for m in sorted(c["min"]))
    if dom == "*" and dow == "*":
        return "Daily at " + times
    if dom == "*" and c["dow"] == {1, 2, 3, 4, 5}:
        return "Weekdays at " + times
    if dom == "*" and c["dow"] == {0, 6}:
        return "Weekends at " + times
    if dom == "*":
        days = sorted(c["dow"], key=lambda d: (d - 1) % 7)  # Monday first
        return "Every %s at %s" % (", ".join(DAY_NAMES[d] for d in days), times)
    if dow == "*" and dom.isdigit():
        return "Monthly on day %s at %s" % (dom, times)
    return raw


def schedule_fields(cron, next_at=None, tz=None):
    """Human text, zone and next runs (14 days) for one cron expression."""
    out = {"cron": cron or "", "schedule": cron or "One-off", "tz": "", "upcoming": [], "next_run_at": next_at}
    if cron:
        try:
            out["tz"] = parse_cron(cron, tz)[1]
            out["schedule"] = describe(cron)
            out["upcoming"] = [t.isoformat().replace("+00:00", "Z") for t in upcoming(cron, NOW, tz=tz)]
        except (ValueError, KeyError):  # bad cron or unknown zone: show it raw
            pass
    out["next_run_at"] = next_at or (out["upcoming"][0] if out["upcoming"] else None)
    return out


def local_tz():
    try:
        return str(Path("/etc/localtime").resolve()).split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        return "UTC"


# ---------------------------------------------------------------- automations

def read_routines(path):
    """Safe fields of a RemoteTrigger `list` result (raw API JSON, an `HTTP 200` line before it is fine)."""
    text = Path(path).read_text(encoding="utf-8")
    start = text.find("{")
    raw = json.loads(text[start:]) if start >= 0 else {}
    if not isinstance(raw.get("data"), list):
        raise SystemExit("%s holds no routine list (API error?): %s" % (path, clip(text, 200)))
    return [slim_routine(r) for r in raw["data"]], bool(raw.get("has_more"))


def slim_routine(r):
    st = r.get("derived_state") or {}
    folders = [Path(str(f.get("path", "") if isinstance(f, dict) else f)).name for f in st.get("folders") or []]
    return {"id": r.get("id"), "name": r.get("name") or "Untitled routine",
            "cron": r.get("cron_expression") or "", "enabled": bool(r.get("enabled")),
            "next_run_at": r.get("next_run_at"), "created_at": r.get("created_at"),
            "updated_at": r.get("updated_at"), "origin": r.get("created_kind") or "",
            "model": st.get("model") or "", "permission_mode": st.get("permission_mode") or "",
            "prompt": st.get("prompt") or "", "folders": folders,
            "connectors": [m.get("name") for m in r.get("mcp_connections") or [] if m.get("name")],
            "notify": (r.get("notifications") or {}).get("channel") or {},
            "keeps_session": bool(r.get("persist_session")),
            "problem": r.get("suspension_reason") or r.get("ended_reason") or ""}


def run_link(run):
    return next((str(run[k]) for k in ("url", "link", "session_url", "claude_url", "web_url")
                 if str(run.get(k) or "").startswith("https://")), "")


def cloud_auto(r, runs):
    a = schedule_fields(r["cron"], r.get("next_run_at"))
    a.update({k: r.get(k) for k in ("id", "name", "enabled", "model", "permission_mode", "prompt", "folders",
                                    "connectors", "notify", "keeps_session", "problem", "created_at", "updated_at")})
    a.update({"kind": "cloud", "where": "Claude cloud", "command": "",
              "origin": "Cowork task" if r.get("origin") == "cowork_task" else "Routine",
              "runs": [{"status": x.get("status") or "", "title": clip(x.get("title"), 90),
                        "started_at": x.get("started_at") or x.get("created_at"),
                        "ended_at": x.get("last_activity_at"), "url": run_link(x)} for x in runs[:6]]})
    return a


def flow_steps(a, flows):
    """Step boxes for an automation's flow diagram: Claude-written labels from cache/flows.json
    (kept while the prompt is unchanged), else the first words of the prompt's numbered lines."""
    digest = hashlib.sha1((a.get("prompt") or a.get("command") or "").encode("utf-8")).hexdigest()[:12]
    saved = flows.get(a["id"]) or {}
    if saved.get("hash") == digest and saved.get("steps"):
        return [{"label": clip(s.get("label"), 28), "sub": clip(s.get("sub"), 40)} for s in saved["steps"][:7]], "claude", digest
    if a.get("command"):
        return [{"label": "Run command", "sub": clip(a["command"], 40)}], "auto", digest
    steps = []
    # ponytail: first three words of each numbered line; /claude-pit writes proper labels into flows.json
    for m in re.finditer(r"^\s*\d+[.)]\s+(.+)$", a.get("prompt") or "", re.M):
        words = re.sub(r"[^\w\s'&/-]", " ", m.group(1)).split()
        steps.append({"label": " ".join(words[:3]), "sub": ""})
    return (steps[:7] or [{"label": "Run prompt", "sub": ""}]), "auto", digest


def project_name(cwd):
    if not cwd:
        return "Unknown"
    if "/scratch-workspaces/" in cwd:
        return "Cowork scratch"
    p = Path(cwd)
    return "Home" if p == HOME else p.name


# ---------------------------------------------------------------- live sessions

def alive(pid):
    try:
        os.kill(int(pid), 0)
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False
    return True


def ms_iso(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).isoformat() if isinstance(ms, (int, float)) and ms else None


APPS = {"claude-desktop": "Desktop app", "cli": "Terminal", "claude-vscode": "VS Code", "claude-jetbrains": "JetBrains"}


def tool_label(name, args):
    """Short, secret-free words for one tool call: file names, not contents; commands shortened."""
    args = args if isinstance(args, dict) else {}
    if name in ("Read", "Write", "Edit", "MultiEdit", "NotebookEdit"):
        return "%s %s" % (name, Path(str(args.get("file_path") or args.get("notebook_path") or "")).name)
    if name == "Bash":  # the tool's own one-line description reads better than the raw command
        return "Run: " + redact(args.get("description") or str(args.get("command") or "").split("\n")[0], 60)
    if name in ("Grep", "Glob"):
        return "Search " + clip(args.get("pattern"), 40)
    if name == "WebFetch":
        return "Fetch " + (urlparse(str(args.get("url") or "")).hostname or "page")
    if name in ("Agent", "Task"):
        return "Agent: " + clip(args.get("description"), 40)
    if name == "Skill":
        return "Skill " + clip(args.get("skill"), 40)
    if name.startswith("mcp__"):
        return "MCP " + name.split("__")[-1]
    return name or "Tool"


# API list prices in USD per million tokens: (input, output, cache read). Cache writes cost 1.25x input
# (5-minute) or 2x input (1-hour). Source: Anthropic pricing as listed in Nov 2026.
# ponytail: a static table; update it when prices change. Unknown models count as "unpriced".
PRICES = {
    "claude-fable-5-2": (8, 40, 0.20), "claude-mythos-5-2": (8, 40, 0.20),
    "claude-fable-5-1": (10, 50, 0.25), "claude-mythos-5-1": (10, 50, 0.25),
    "claude-fable-5": (10, 50, 1.00), "claude-mythos-5": (10, 50, 1.00),
    "claude-opus-5-5": (4, 20, 0.20), "claude-opus-5": (5, 25, 0.50),
    "claude-opus-4-8": (5, 25, 0.50), "claude-opus-4-7": (5, 25, 0.50), "claude-opus-4-6": (5, 25, 0.50),
    "claude-sonnet-5-5": (2, 10, 0.10), "claude-sonnet-5": (2, 10, 0.20), "claude-sonnet-4-6": (3, 15, 0.30),
    "claude-haiku-5-5": (0.10, 0.50, 0.01), "claude-haiku-4-5": (1, 5, 0.10),
}
SMALL_WINDOW = ("claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-5", "claude-opus-4-1", "claude-opus-4-0",
                "claude-sonnet-4-0", "claude-3")


def message_cost(model, u):
    """API-equivalent USD for one reply, or None when the model has no known price."""
    key = next((k for k in sorted(PRICES, key=len, reverse=True) if (model or "").startswith(k)), None)
    if not key or not isinstance(u, dict):
        return None
    inp, out, read = PRICES[key]
    cc = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
    hour = cc.get("ephemeral_1h_input_tokens") or 0
    five = max((u.get("cache_creation_input_tokens") or 0) - hour, 0)
    usd = ((u.get("input_tokens") or 0) * inp + five * inp * 1.25 + hour * inp * 2
           + (u.get("cache_read_input_tokens") or 0) * read + (u.get("output_tokens") or 0) * out) / 1e6
    return usd * (2 if u.get("speed") == "fast" else 1)  # fast mode is twice the price where offered


def context_window(model):
    return 200_000 if (model or "").startswith(SMALL_WINDOW) else 1_000_000


def iso(t):
    return t.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def prompt_text(o, blocks):
    """The text of a real user prompt, or '' for tool results and injected <tag> blocks."""
    if o.get("toolUseResult") or o.get("isMeta") or any(isinstance(b, dict) and b.get("type") == "tool_result" for b in blocks):
        return ""
    content = (o.get("message") or {}).get("content")
    text = content if isinstance(content, str) else " ".join(
        str(b.get("text") or "") for b in blocks if isinstance(b, dict) and b.get("type") == "text")
    return "" if text.lstrip().startswith("<") else text.strip()


def tail_events(path, limit=8, size=262_144):
    """Last steps of one transcript (newest first) from its last 256 KB, plus the context size and model."""
    try:
        with open(path, "rb") as f:
            end = f.seek(0, 2)
            f.seek(max(0, end - size))
            lines = f.read().decode("utf-8", "replace").splitlines()[1 if end > size else 0:]
    except OSError:
        return [], 0, ""
    events, ctx, model = [], 0, ""
    for line in lines:
        try:
            o = json.loads(line)
        except ValueError:
            continue
        msg = o.get("message") if isinstance(o.get("message"), dict) else {}
        blocks = msg.get("content") if isinstance(msg.get("content"), list) else []
        if o.get("type") == "assistant":
            u = msg.get("usage") or {}
            if u and msg.get("model") != "<synthetic>":
                ctx = sum(u.get(k) or 0 for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                model = msg.get("model") or model
            for b in blocks:
                if isinstance(b, dict) and b.get("type") == "tool_use":
                    events.append({"t": o.get("timestamp"), "kind": "tool", "label": tool_label(b.get("name") or "", b.get("input"))})
                elif isinstance(b, dict) and b.get("type") == "text" and str(b.get("text") or "").strip():
                    events.append({"t": o.get("timestamp"), "kind": "reply", "label": "Reply"})
        elif o.get("type") == "user" and prompt_text(o, blocks):
            events.append({"t": o.get("timestamp"), "kind": "prompt", "label": "Your prompt"})
    return events[-limit:][::-1], ctx, model


def app_sessions():
    """Claude desktop app session records (title, model, turns, last activity), by Claude Code session id."""
    meta = {}
    for f in APP.glob("claude-code-sessions/*/*/local_*.json"):
        m = load_json(f, {}) or {}
        if m.get("cliSessionId"):
            meta[m["cliSessionId"]] = m
    return meta


def plan_usage():
    """Plan limits: the newer of what /claude-pit saved from the app and the app's own last sample."""
    saved = load_json(CACHE / "plan_usage.json", {}) or {}
    rows = []
    if saved.get("windows"):
        rows.append({"plan": saved.get("plan") or "", "at": saved.get("at"), "source": "app",
                     "windows": [{"label": w.get("label"), "percent": w.get("percentUsed"), "resets_at": w.get("resetsAt")}
                                 for w in saved["windows"]]})
    samples = (load_json(APP / "plan-usage-history.json", {}) or {}).get("samples") or []
    if samples and isinstance(samples[-1], dict):
        u = samples[-1].get("u") or {}
        rows.append({"plan": saved.get("plan") or "", "at": ms_iso(samples[-1].get("t")), "source": "history",
                     "windows": [{"label": "5-hour limit", "percent": u.get("fh"), "resets_at": None},
                                 {"label": "Weekly · all models", "percent": u.get("sd"), "resets_at": None}]})
    return max(rows, key=lambda r: r["at"] or "") if rows else None


def live_sessions(meta=None):
    """Running Claude Code sessions (~/.claude/sessions), recent desktop app sessions and plan limits."""
    meta = app_sessions() if meta is None else meta
    running = []
    for f in (CLAUDE / "sessions").glob("*.json"):
        s = load_json(f, {}) or {}
        if not s.get("sessionId") or not alive(s.get("pid")):
            continue
        m = meta.get(s["sessionId"], {})
        transcript = next((CLAUDE / "projects").glob("*/%s.jsonl" % s["sessionId"]), None)
        events, ctx, model = tail_events(transcript) if transcript else ([], 0, "")
        model = model or m.get("model") or ""
        status = str(s.get("status") or "idle")
        tool = next((e["label"] for e in events if e["kind"] == "tool"), "")
        doing = (tool or "Thinking") if status == "busy" else (
            "Waiting for you" if re.search("wait|input|permission", status) else "Idle")
        running.append({"id": s["sessionId"], "title": s.get("name") or m.get("title") or "Untitled session",
                        "project": project_name(s.get("cwd")), "app": APPS.get(s.get("entrypoint"), s.get("entrypoint") or ""),
                        "status": status, "doing": doing, "status_since": ms_iso(s.get("statusUpdatedAt")),
                        "started_at": ms_iso(s.get("startedAt")), "model": model, "effort": m.get("effort") or "",
                        "turns": m.get("completedTurns") or 0, "events": events,
                        "context": {"tokens": ctx, "window": context_window(model)} if ctx else None})
    running.sort(key=lambda r: (r["status"] != "busy", r["title"]))
    live_ids = {r["id"] for r in running}
    recent = sorted((m for m in meta.values() if not m.get("isArchived")), key=lambda m: -(m.get("lastActivityAt") or 0))
    return {"at": NOW.isoformat(), "running": running, "limits": plan_usage(),
            "recent": [{"id": m.get("cliSessionId"), "title": m.get("title") or "Untitled session",
                        "project": project_name(m.get("cwd")), "last_at": ms_iso(m.get("lastActivityAt")),
                        "turns": m.get("completedTurns") or 0, "model": m.get("model") or "",
                        "running": m.get("cliSessionId") in live_ids} for m in recent[:12]]}


def transcripts(meta, days=30, event_days=7, max_events=150):
    """One pass over the Claude Code transcripts: usage and API-equivalent cost per day and model,
    totals per session, the latest events (tool calls, prompts, replies, tool errors) and tool counts."""
    zone = ZoneInfo(local_tz())
    today = NOW.astimezone(zone).date()
    start = today - dt.timedelta(days=days - 1)
    since = NOW - dt.timedelta(days=event_days)
    month = today.strftime("%Y-%m")
    per_day = {start + dt.timedelta(days=i): {"sessions": set(), "messages": 0, "output_tokens": 0,
                                              "input_tokens": 0, "cost": 0.0} for i in range(days)}
    models, projects, apps, titles, sessions = {}, {}, {}, {}, {}
    tools, seen, events = collections.Counter(), set(), []
    errors = unpriced = 0
    month_cost, window_sessions, first = 0.0, set(), None
    for f in (CLAUDE / "projects").glob("*/*.jsonl"):
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"assistant"' not in line and '"user"' not in line and '"custom-title"' not in line:
                    continue  # cheap prefilter: most lines are bookkeeping
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                kind, sid = o.get("type"), o.get("sessionId") or ""
                if kind == "custom-title":
                    titles[sid] = o.get("customTitle") or titles.get(sid)
                    continue
                if kind not in ("assistant", "user"):
                    continue
                try:
                    t = dt.datetime.fromisoformat(str(o["timestamp"]).replace("Z", "+00:00"))
                except (KeyError, ValueError):
                    continue
                m = o.get("message") if isinstance(o.get("message"), dict) else {}
                if m.get("model") == "<synthetic>":
                    continue
                blocks = m.get("content") if isinstance(m.get("content"), list) else []
                s = sessions.setdefault(sid, {"id": sid, "project": project_name(o.get("cwd")), "first": t, "last": t,
                                              "app": APPS.get(o.get("entrypoint"), o.get("entrypoint") or ""),
                                              "replies": 0, "prompts": 0, "tools": 0, "output_tokens": 0, "cost": 0.0,
                                              "models": collections.Counter()})
                s["first"], s["last"] = min(s["first"], t), max(s["last"], t)
                local = t.astimezone(zone)
                day, recent = per_day.get(local.date()), t >= since
                if kind == "user":
                    failed = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error")]
                    if failed:
                        errors += len(failed) if day is not None else 0
                        if recent:
                            events.append({"t": iso(t), "kind": "error", "label": "Tool error", "sid": sid})
                    elif prompt_text(o, blocks):
                        s["prompts"] += 1
                        if recent:
                            events.append({"t": iso(t), "kind": "prompt", "label": "Your prompt", "sid": sid})
                    continue
                for b in blocks:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        s["tools"] += 1
                        if day is not None:  # MCP tools show by tool name; their server ids are opaque
                            name = b.get("name") or "?"
                            tools["MCP " + name.split("__")[-1] if name.startswith("mcp__") else name] += 1
                        if recent:
                            events.append({"t": iso(t), "kind": "tool", "sid": sid,
                                           "label": tool_label(b.get("name") or "", b.get("input"))})
                    elif isinstance(b, dict) and b.get("type") == "text" and str(b.get("text") or "").strip() and recent:
                        events.append({"t": iso(t), "kind": "reply", "label": "Reply", "sid": sid})
                key = m.get("id") or o.get("uuid")
                if key in seen:  # one reply can span several lines; count its usage once
                    continue
                seen.add(key)
                u = m.get("usage") or {}
                usd, out = message_cost(m.get("model"), u), u.get("output_tokens") or 0
                s["replies"] += 1
                s["output_tokens"] += out
                s["cost"] += usd or 0
                s["models"][m.get("model") or "unknown"] += 1
                unpriced += out if usd is None else 0
                first = min(first, local.date()) if first else local.date()
                month_cost += (usd or 0) if local.strftime("%Y-%m") == month else 0
                if day is None:
                    continue
                window_sessions.add(sid)
                day["sessions"].add(sid)
                day["messages"] += 1
                day["output_tokens"] += out
                day["input_tokens"] += sum(u.get(k) or 0 for k in
                                           ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                day["cost"] += usd or 0
                mm = models.setdefault(m.get("model") or "unknown", {"name": m.get("model") or "unknown", "output_tokens": 0, "cost": 0.0})
                mm["output_tokens"] += out
                mm["cost"] += usd or 0
                apps.setdefault(o.get("entrypoint") or "cli", set()).add(sid)
                p = projects.setdefault(s["project"], {"sessions": set(), "last": ""})
                p["sessions"].add(sid)
                p["last"] = max(p["last"], local.isoformat())

    def title(sid):
        return titles.get(sid) or (meta.get(sid) or {}).get("title") or "Untitled session"

    usage = (load_json(HOME / ".claude.json", {}) or {}).get("skillUsage") or {}
    skills_used = sorted(({"name": k, "count": v.get("usageCount", 0), "last": ms_iso(v.get("lastUsedAt"))}
                          for k, v in usage.items() if isinstance(v, dict)), key=lambda s: -s["count"])
    rows = [{"date": d.isoformat(), "sessions": len(v["sessions"]), "messages": v["messages"], "output_tokens": v["output_tokens"],
             "input_tokens": v["input_tokens"], "cost": round(v["cost"], 4)} for d, v in sorted(per_day.items())]
    activity = {
        "days": rows, "window": days,
        "totals": {"sessions": len(sessions), "window_sessions": len(window_sessions), "messages": len(seen),
                   "first_day": first.isoformat() if first else None, "active_days": sum(1 for r in rows if r["messages"])},
        "models": sorted(({"name": v["name"], "output_tokens": v["output_tokens"], "cost": round(v["cost"], 4)}
                          for v in models.values()), key=lambda m: -m["cost"]),
        "apps": sorted(({"name": APPS.get(k, k), "sessions": len(v)} for k, v in apps.items()), key=lambda a: -a["sessions"]),
        "projects": sorted(({"name": k, "sessions": len(v["sessions"]), "last": v["last"]} for k, v in projects.items()),
                           key=lambda p: -p["sessions"])[:8],
        "skills_used": skills_used[:10],
        "tools": [{"name": k, "count": v} for k, v in tools.most_common(12)], "tool_errors": errors,
    }
    cost = {"currency": "USD", "today": round(per_day[today]["cost"], 4), "month": round(month_cost, 4),
            "window": round(sum(r["cost"] for r in rows), 4), "unpriced_tokens": unpriced}
    history = [{"id": sid, "title": title(sid), "project": s["project"], "app": s["app"],
                "model": s["models"].most_common(1)[0][0] if s["models"] else "", "started": iso(s["first"]),
                "last": iso(s["last"]), "replies": s["replies"], "prompts": s["prompts"], "tools": s["tools"],
                "output_tokens": s["output_tokens"], "cost": round(s["cost"], 4)}
               for sid, s in sessions.items() if s["replies"]]
    history.sort(key=lambda h: h["last"], reverse=True)
    events.sort(key=lambda e: e["t"], reverse=True)
    activity["event_counts"] = dict(collections.Counter(e["kind"] for e in events))  # all of the last 7 days
    for e in events[:max_events]:
        e["session"], e["project"] = title(e["sid"]), sessions[e["sid"]]["project"]
    return activity, cost, history[:300], events[:max_events]


def search_transcripts(query, limit=30):
    """Sessions whose prompts or replies contain `query` (case-insensitive), with short snippets. Local only."""
    q = query.strip().lower()
    if len(q) < 2:
        return []
    meta, hits = app_sessions(), {}
    for f in (CLAUDE / "projects").glob("*/*.jsonl"):
        try:
            fh = open(f, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if q not in line.lower():
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                m = o.get("message") if isinstance(o.get("message"), dict) else {}
                blocks = m.get("content") if isinstance(m.get("content"), list) else []
                if o.get("type") == "user":
                    text, who = prompt_text(o, blocks), "you"
                elif o.get("type") == "assistant":
                    text, who = " ".join(str(b.get("text") or "") for b in blocks if isinstance(b, dict) and b.get("type") == "text"), "claude"
                else:
                    continue
                i = text.lower().find(q)
                if i < 0:
                    continue
                sid = o.get("sessionId") or f.stem
                h = hits.setdefault(sid, {"id": sid, "title": (meta.get(sid) or {}).get("title") or "Untitled session",
                                          "project": project_name(o.get("cwd")), "last": o.get("timestamp"), "matches": 0, "snippets": []})
                h["matches"] += 1
                h["last"] = max(h["last"] or "", o.get("timestamp") or "")
                if len(h["snippets"]) < 3:
                    h["snippets"].append({"who": who, "t": o.get("timestamp"),
                                          "text": redact(text[max(0, i - 70): i + len(q) + 90], 200)})
    return sorted(hits.values(), key=lambda h: (-h["matches"], h["last"] or ""))[:limit]


def memory_files(cfg):
    """CLAUDE.md files and auto-memory notes: path, scope and a one-line description (no content)."""
    names = {re.sub(r"[^A-Za-z0-9]", "-", p): project_name(p) for p in (cfg.get("projects") or {})}
    rows = []

    def add(path, scope, project):
        p = Path(path)
        if not p.is_file():
            return
        meta, st = frontmatter(p), p.stat()
        desc = meta.get("description")
        if not desc:
            lines = [ln.strip() for ln in p.read_text(encoding="utf-8", errors="replace").splitlines() if ln.strip()]
            desc = ("Index of %d notes" % sum(1 for ln in lines if ln.startswith("- ["))) if p.name == "MEMORY.md" \
                else next((ln.lstrip("# ") for ln in lines if not ln.startswith("---")), "")
        rows.append({"path": str(p).replace(str(HOME), "~", 1), "name": p.name, "scope": scope, "project": project,
                     "description": clip(desc, 160), "size": st.st_size, "updated": ms_iso(st.st_mtime * 1000)})

    add(CLAUDE / "CLAUDE.md", "user", "All projects")
    for proj in cfg.get("projects") or {}:
        p = Path(proj)
        if p.is_dir() and p != HOME:
            for rel in ("CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"):
                add(p / rel, "project", p.name)
    for d in sorted((CLAUDE / "projects").glob("*/memory")):
        for f in sorted(d.glob("*.md"), key=lambda x: (x.name != "MEMORY.md", x.name)):
            add(f, "memory", names.get(d.parent.name) or (
                "Cowork scratch" if "scratch-workspaces" in d.parent.name else d.parent.name.split("-")[-1]))
    return rows


def desktop_auto(t):
    """A Claude desktop app scheduled task, as written to cache/desktop_tasks.json by the /claude-pit skill."""
    a = schedule_fields(t.get("cronExpression") or "", t.get("nextRunAt"), tz=local_tz())
    if t.get("schedule"):
        a["schedule"] = t["schedule"]
    if not t.get("cronExpression") and t.get("fireAt"):
        a["schedule"], a["next_run_at"] = "Once", t["fireAt"]
    a.update({"id": "desktop:%s" % t.get("taskId"), "name": t.get("title") or t.get("taskId") or "Scheduled task",
              "kind": "desktop", "where": "This Mac (Claude app)", "origin": "Scheduled task",
              "enabled": bool(t.get("enabled", True)), "prompt": clip(t.get("description"), 800),
              "model": t.get("model") or "", "permission_mode": "", "connectors": [], "notify": {},
              "keeps_session": False, "problem": t.get("notRead") or "", "command": "", "folders": [],
              "runs": [{"status": "", "title": "Last run", "started_at": t["lastRunAt"], "url": ""}]
              if t.get("lastRunAt") else []})
    return a


def local_auto(name, kind, cmd, on, cron, tz):
    a = schedule_fields(cron, tz=tz)
    a.update({"id": "%s:%s" % (kind, name), "name": name, "kind": kind, "where": "This Mac",
              "origin": "launchd agent" if kind == "launchd" else "crontab", "enabled": on,
              "command": redact(cmd), "prompt": "", "model": "", "permission_mode": "", "connectors": [],
              "notify": {}, "keeps_session": False, "problem": "", "folders": [], "runs": []})
    return a


CLAUDE_CMD = re.compile(r"(^|[\s/])claude(\s|$)")


def local_jobs():
    """launchd agents and crontab lines on this Mac that run the `claude` CLI."""
    tz, jobs = local_tz(), []
    # ponytail: matches the command line only; a wrapper script that calls claude inside is missed,
    # and only the first StartCalendarInterval entry is read.
    for plist in sorted((HOME / "Library" / "LaunchAgents").glob("*.plist")):
        try:
            with open(plist, "rb") as f:
                p = plistlib.load(f)
        except Exception:
            continue
        cmd = " ".join(map(str, p.get("ProgramArguments") or [p.get("Program", "")]))
        if not CLAUDE_CMD.search(cmd):
            continue
        cal = p.get("StartCalendarInterval")
        cals = [c for c in (cal if isinstance(cal, list) else [cal]) if isinstance(c, dict)]
        cron = " ".join(str(cals[0].get(k, "*")) for k in ("Minute", "Hour", "Day", "Month", "Weekday")) if cals else ""
        a = local_auto(p.get("Label") or plist.stem, "launchd", cmd, not p.get("Disabled", False), cron, tz)
        if not cron and p.get("StartInterval"):
            a["schedule"] = "Every %s seconds" % p["StartInterval"]
        jobs.append(a)
    try:
        tab = subprocess.run(["crontab", "-l"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        tab = ""
    for line in map(str.strip, tab.splitlines()):
        if line and not line.startswith("#") and CLAUDE_CMD.search(line):
            parts = line.split(None, 1 if line.startswith("@") else 5)
            if len(parts) >= 2:
                jobs.append(local_auto("crontab: " + clip(parts[-1], 40), "cron", parts[-1], True,
                                       " ".join(parts[:-1]), tz))
    return jobs


# ---------------------------------------------------------------- plugins, MCP, skills

def plugin_parts(root, name, needs):
    """What one plugin folder ships: skills, commands, agents, hooks and MCP servers."""
    root = Path(root)
    mf = load_json(root / ".claude-plugin" / "plugin.json", {}) or {}

    def paths(key):  # default folder plus any extra paths the manifest lists
        extra = mf.get(key) or []
        extra = extra if isinstance(extra, list) else [extra]
        return list(dict.fromkeys([root / key] + [root / p for p in extra if isinstance(p, str)]))

    hooks = mf.get("hooks")
    hooks = load_json(root / hooks, {}) if isinstance(hooks, str) else hooks
    if not isinstance(hooks, dict):
        hooks = load_json(root / "hooks" / "hooks.json", {}) or {}
    if isinstance(hooks.get("hooks"), dict):
        hooks = hooks["hooks"]
    mcp = mf.get("mcpServers")
    mcp = load_json(root / mcp, {}) if isinstance(mcp, str) else mcp
    if not isinstance(mcp, dict):
        mcp = load_json(root / ".mcp.json", {}) or {}
    if isinstance(mcp.get("mcpServers"), dict):
        mcp = mcp["mcpServers"]
    src = "plugin:" + name
    return mf, {"skills": md_items(paths("skills"), src, "skill"),
                "commands": md_items(paths("commands"), src, "md"),
                "agents": md_items(paths("agents"), src, "md", 140),
                "hooks": hook_rows(hooks, src),
                "mcp": mcp_rows(mcp, src, needs, src + ":")}


def plugin_row(name, market, desc, part, surface, on, version, updated):
    return {"name": name, "marketplace": market, "surface": surface, "enabled": bool(on),
            "version": str(version or ""), "updated_at": updated or "", "description": clip(desc, 220),
            "counts": {k: len(v) for k, v in part.items()}}


def desktop_app_mcp():
    """Claude desktop app extensions and config servers (only the enabled flag is read from settings)."""
    rows = []
    for ext_id, e in ((load_json(APP / "extensions-installations.json", {}) or {}).get("extensions") or {}).items():
        man = e.get("manifest") or {}
        on = (load_json(APP / "Claude Extensions Settings" / (ext_id + ".json"), {}) or {}).get("isEnabled", True)
        rows.append({"name": man.get("display_name") or man.get("name") or ext_id, "scope": "extension",
                     "host": "", "transport": "stdio", "status": "enabled" if on else "disabled",
                     "version": e.get("version") or man.get("version") or "", "surface": "app"})
    cfg = load_json(APP / "claude_desktop_config.json", {}) or {}
    return rows + [dict(r, surface="app") for r in mcp_rows(cfg.get("mcpServers"), "config", set())]


def connector_rows(routines, cfg, needs):
    """claude.ai connectors, as seen by routines and by Claude Code."""
    names = {}
    for r in routines:
        for n in r.get("connectors") or []:
            names.setdefault(norm(n), n.replace("_", " "))
    for n in cfg.get("claudeAiMcpEverConnected") or []:
        n = n.replace("claude.ai ", "", 1)
        names[norm(n)] = n  # this spelling keeps punctuation (draw.io)
    pending = {norm(k[10:]) for k in needs if k.startswith("claude.ai ")}
    for k in needs:
        if k.startswith("claude.ai "):
            names.setdefault(norm(k[10:]), k[10:])
    return [{"name": n, "scope": "connector", "host": "", "transport": "http", "surface": "claude.ai",
             "status": "needs sign-in" if key in pending else ""}
            for key, n in sorted(names.items(), key=lambda kv: kv[1].lower())]


# ---------------------------------------------------------------- health

def health(autos, plugins, items):
    out = []

    def add(level, title, detail=""):
        out.append({"level": level, "title": title, "detail": detail})

    pending = {norm(m["name"]) for m in items["mcp"] if m["status"] == "needs sign-in" and m["scope"] == "connector"}
    for a in autos:
        last = a["runs"][0] if a["runs"] else {}
        if a["problem"]:
            add("warning", a["name"] + " has stopped", a["problem"])
        elif not a["enabled"]:
            add("caution", a["name"] + " is paused", "It will not run until it is turned back on.")
        elif not a["next_run_at"] and a["kind"] != "launchd":
            add("caution", a["name"] + " has no upcoming run", a["schedule"])
        if last.get("status") == "failed":
            add("warning", "Last run of " + a["name"] + " failed", last.get("title", ""))
        elif a["kind"] == "cloud" and not a["runs"]:
            add("info", a["name"] + " has not run yet", "No run history recorded so far.")
        hit = sorted(c for c in a["connectors"] if norm(c) in pending)
        if hit:
            add("caution", a["name"] + " uses connectors that need sign-in", ", ".join(hit))
    waiting = [m["name"] for m in items["mcp"] if m["status"] == "needs sign-in"]
    if waiting:
        add("info", "%d MCP servers need sign-in" % len(waiting),
            ", ".join(waiting) + ". Sign in with /mcp if you use them.")
    off = [p["name"] for p in plugins if not p["enabled"]]
    if off:
        add("info", "%d installed plugins are turned off" % len(off), ", ".join(off))
    busy = sorted({h["source"] for h in items["hooks"] if h["event"] in ("UserPromptSubmit", "PreToolUse", "PostToolUse")})
    if busy:
        add("info", "Hooks run on every prompt or tool call", "From " + ", ".join(busy) + ". Each adds a little to every turn.")
    seen = {}
    for s in items["skills"]:
        seen.setdefault(s["name"].split(":")[-1], set()).add(s["source"])
    dup = sorted(n for n, srcs in seen.items() if len(srcs) > 1)
    if dup:
        add("info", "%d skill names exist in more than one place" % len(dup), ", ".join(dup[:15]))
    if not any(x["level"] in ("warning", "caution") for x in out):
        add("ok", "Nothing needs attention", "No failed runs, paused schedules or blocked connectors.")
    order = {"warning": 0, "caution": 1, "info": 2, "ok": 3}
    return sorted(out, key=lambda x: order[x["level"]])


def usage_health(cost, budget, limits, live, activity):
    """Budget, plan limits, full context windows and tool errors."""
    out = []
    if budget:
        share = cost["month"] / budget
        if share >= 1:
            out.append({"level": "warning", "title": "Over this month's budget",
                        "detail": "$%.2f of $%.2f (API-equivalent)." % (cost["month"], budget)})
        elif share >= 0.8:
            out.append({"level": "caution", "title": "%d%% of this month's budget used" % (share * 100),
                        "detail": "$%.2f of $%.2f (API-equivalent)." % (cost["month"], budget)})
    for w in (limits or {}).get("windows") or []:
        if (w.get("percent") or 0) >= 80:
            out.append({"level": "caution", "title": "%s at %d%%" % (w.get("label"), w["percent"]),
                        "detail": "Claude slows down or stops at 100%% until the limit resets."})
    for s in live["running"]:
        c = s.get("context")
        if c and c["tokens"] / c["window"] >= 0.85:
            out.append({"level": "info", "title": "%s is %d%% through its context window" % (s["title"], 100 * c["tokens"] / c["window"]),
                        "detail": "Claude compacts the conversation soon; start a new session for a fresh task."})
    if activity.get("tool_errors"):
        out.append({"level": "info", "title": "%d tool calls failed in %d days" % (activity["tool_errors"], activity["window"]),
                    "detail": "See Events for which ones."})
    return out


def new_alerts(autos, health_items):
    """Warnings not alerted before (failed runs, budget), remembered in cache/alerts_sent.json."""
    sent = set(load_json(CACHE / "alerts_sent.json", []) or [])
    fresh = []
    for a in autos:
        last = a["runs"][0] if a["runs"] else {}
        if last.get("status") == "failed":
            fresh.append(("run:%s:%s" % (a["id"], last.get("started_at")), "Run failed: " + a["name"]))
    for h in health_items:
        if h["level"] == "warning" and h["title"].startswith("Over this month"):
            fresh.append(("budget:" + NOW.strftime("%Y-%m"), "Claude Pit: " + h["title"] + " " + h["detail"]))
    fresh = [(k, msg) for k, msg in fresh if k not in sent]
    if fresh:
        CACHE.mkdir(exist_ok=True)
        (CACHE / "alerts_sent.json").write_text(json.dumps(sorted(sent | {k for k, _ in fresh})), encoding="utf-8")
    return [msg for _, msg in fresh]


# ---------------------------------------------------------------- assemble

def collect(routines_file=None):
    settings = load_json(CLAUDE / "settings.json", {}) or {}
    cfg = load_json(HOME / ".claude.json", {}) or {}
    needs = needs_signin()
    plugins, items = [], {"skills": [], "commands": [], "agents": [], "hooks": [], "mcp": []}

    def add(part, surface):
        for key, rows in part.items():
            items[key] += [dict(r, surface=r.get("surface", surface)) for r in rows]

    # Claude Code plugins
    enabled = settings.get("enabledPlugins") or {}
    installed = (load_json(CLAUDE / "plugins" / "installed_plugins.json", {}) or {}).get("plugins") or {}
    for key, installs in installed.items():
        name, _, market = key.partition("@")
        inst = installs[0] if installs else {}
        mf, part = plugin_parts(inst.get("installPath") or "/nonexistent", name, needs)
        plugins.append(plugin_row(name, market, mf.get("description"), part, "code", enabled.get(key),
                                  inst.get("version") or mf.get("version"), inst.get("lastUpdated")))
        add(part, "code")

    # claude.ai plugins synced to this computer (Claude app, Cowork and Claude Code all use them)
    for man in sorted((CLAUDE / "plugins" / "synced").glob("*/manifest.json")):
        for p in (load_json(man, {}) or {}).get("plugins") or []:
            name = p.get("name") or "?"
            root = next((d for d in [man.parent / name] + sorted(man.parent.glob(name + "~*")) if d.is_dir()),
                        man.parent / name)
            mf, part = plugin_parts(root, name, needs)
            plugins.append(plugin_row(name, p.get("marketplaceName") or "", p.get("description") or mf.get("description"),
                                      part, "chat", True, p.get("version"), p.get("updatedAt")))
            add(part, "chat")

    # your own Claude Code skills, agents, commands, hooks and MCP servers
    add({"skills": md_items([CLAUDE / "skills"], "you", "skill"),
         "agents": md_items([CLAUDE / "agents"], "you", "md", 140),
         "commands": md_items([CLAUDE / "commands"], "you", "md"),
         "hooks": hook_rows(settings.get("hooks"), "settings.json"),
         "mcp": mcp_rows(cfg.get("mcpServers"), "user", needs)}, "code")

    # per-project ones
    for proj, pc in (cfg.get("projects") or {}).items():
        p = Path(proj)
        if p == HOME or not p.is_dir():
            continue
        src = "project:" + p.name
        hooks = []
        for name in ("settings.json", "settings.local.json"):
            hooks += hook_rows((load_json(p / ".claude" / name, {}) or {}).get("hooks"), src)
        add({"skills": md_items([p / ".claude" / "skills"], src, "skill"),
             "agents": md_items([p / ".claude" / "agents"], src, "md", 140),
             "commands": md_items([p / ".claude" / "commands"], src, "md"),
             "hooks": hooks,
             "mcp": mcp_rows((pc or {}).get("mcpServers"), src, needs)
             + mcp_rows((load_json(p / ".mcp.json", {}) or {}).get("mcpServers"), src, needs)}, "code")

    # claude.ai skills: Anthropic's (synced here) and your uploaded ones (cached by /claude-pit)
    for man in sorted((CLAUDE / "skills" / "synced").glob("*/manifest.json")):
        for s in (load_json(man, {}) or {}).get("skills") or []:
            items["skills"].append({"name": s.get("name") or s.get("skillId") or "?",
                                    "description": clip(s.get("description"), 180), "surface": "chat",
                                    "source": "Anthropic" if "anthropic" in (str(s.get("creatorType")) + str(s.get("source")))
                                    else "claude.ai"})
    for s in load_json(CACHE / "chat_skills.json", []) or []:
        items["skills"].append({"name": s.get("name") or "?", "description": clip(s.get("description"), 180),
                                "surface": "chat", "source": "you"})

    # automations
    cached = load_json(CACHE / "routines.json", {}) or {}
    routines, more = cached.get("routines") or [], False
    synced = cached.get("synced_at")
    if routines_file:
        routines, more = read_routines(routines_file)
        synced = NOW.isoformat()
        CACHE.mkdir(exist_ok=True)
        (CACHE / "routines.json").write_text(json.dumps({"synced_at": synced, "routines": routines},
                                                        indent=1, ensure_ascii=False), encoding="utf-8")
    runs = load_json(CACHE / "runs.json", {}) or {}
    autos = [cloud_auto(r, runs.get(r["id"]) or []) for r in routines]
    autos += [desktop_auto(t) for t in load_json(CACHE / "desktop_tasks.json", []) or []]
    autos += local_jobs()
    autos.sort(key=lambda a: (not a["enabled"], a["next_run_at"] or "9999"))
    flows = load_json(CACHE / "flows.json", {}) or {}
    for a in autos:
        a["steps"], a["steps_source"], a["prompt_hash"] = flow_steps(a, flows)

    items["mcp"] = connector_rows(routines, cfg, needs) + items["mcp"] + desktop_app_mcp()
    items["memory"] = memory_files(cfg)
    meta = app_sessions()
    act, cost, history, events = transcripts(meta)
    live = live_sessions(meta)
    try:
        budget = float((load_json(CACHE / "settings.json", {}) or {}).get("monthly_budget_usd") or 0) or None
    except (TypeError, ValueError):
        budget = None
    cost["budget"] = budget
    report = health(autos, plugins, items)
    extra = usage_health(cost, budget, live["limits"], live, act)
    report = [h for h in report if h["level"] != "ok" or not any(x["level"] in ("warning", "caution") for x in extra)]
    report = sorted(extra + report, key=lambda x: {"warning": 0, "caution": 1, "info": 2, "ok": 3}[x["level"]])
    if more:
        report.insert(0, {"level": "caution", "title": "Only the first page of routines was read",
                          "detail": "The routines API said there are more."})
    return {"version": 3, "generated_at": NOW.isoformat(), "routines_synced_at": synced,
            "timezone": local_tz(),
            "settings": {"model": settings.get("model") or "", "effort": settings.get("effortLevel") or ""},
            "automations": autos, "plugins": plugins, **items, "health": report, "activity": act, "cost": cost,
            "history": history, "events": events, "live": live, "pit_dir": str(ROOT).replace(str(HOME), "~", 1)}


SKELETON = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '</head><body>\n{}\n</body></html>\n')
CSS_TAG, JS_TAG = '<link rel="stylesheet" href="app.css">', '<script src="app.js"></script>'


def inline_safe(text):
    """Keep inlined JS/JSON from closing its <script> early."""
    return text.replace("</", "<\\/").replace("<!--", "<\\!--")


LIBRARY = ("plugins", "mcp", "skills", "agents", "commands", "hooks", "memory")  # changes rarely, so it ships apart


def build(data):
    """The artifact (out/index.html, app.js, app.css, data.json, library.json) and out/claude-pit.html,
    one file that opens offline. Returns the page path and whether library.json changed."""
    shell = (ROOT / "shell.html").read_text(encoding="utf-8")
    if shell.count(CSS_TAG) != 1 or shell.count(JS_TAG) != 1:
        raise SystemExit("shell.html must reference app.css and app.js exactly once")
    try:
        js, css = (BUILD / "app.js").read_text(encoding="utf-8"), (BUILD / "app.css").read_text(encoding="utf-8")
    except OSError:
        raise SystemExit("build/app.js is missing: run `npm install && npm run build` first")
    dump = lambda obj: json.dumps(obj, ensure_ascii=False, separators=(",", ":"))  # noqa: E731
    live = dump({k: v for k, v in data.items() if k not in LIBRARY})
    lib = dump({k: data[k] for k in LIBRARY})
    OUT.mkdir(exist_ok=True)
    old = OUT / "library.json"
    changed = not old.exists() or old.read_text(encoding="utf-8") != lib
    for name, text in (("index.html", shell), ("app.js", js), ("app.css", css), ("data.json", live), ("library.json", lib)):
        (OUT / name).write_text(text, encoding="utf-8")
    one = shell.replace(CSS_TAG, "<style>" + css + "</style>").replace(
        JS_TAG, "<script>window.__PIT_DATA__=" + inline_safe(dump(data)) + "</script><script>" + inline_safe(js) + "</script>")
    for lib_name in ("react", "react-dom"):  # inline React when installed, so the one-file page opens offline
        umd = ROOT / "node_modules" / lib_name / "umd" / (lib_name + ".production.min.js")
        tag = re.search(r'<script src="https://[^"]+/%s\.production\.min\.js"></script>' % re.escape(lib_name), one)
        if umd.exists() and tag:
            one = one.replace(tag.group(0), "<script>" + inline_safe(umd.read_text(encoding="utf-8")) + "</script>")
    (OUT / "claude-pit.html").write_text(SKELETON.format(one), encoding="utf-8")
    return OUT / "index.html", changed


# ---------------------------------------------------------------- checks

def selftest():
    import tempfile
    utc = dt.timezone.utc
    now = dt.datetime(2026, 11, 25, 12, 0, tzinfo=utc)  # 20:00 in Kuala Lumpur
    daily = "CRON_TZ=Asia/Kuala_Lumpur 37 7 * * *"
    assert upcoming(daily, now, days=2) == [dt.datetime(2026, 11, 25, 23, 37, tzinfo=utc),
                                            dt.datetime(2026, 11, 26, 23, 37, tzinfo=utc)]
    assert describe(daily) == "Daily at 07:37"
    assert describe("*/15 * * * *") == "Every 15 minutes"
    assert describe("0 9 * * 1-5") == "Weekdays at 09:00"
    assert describe("30 8 * * mon,wed") == "Every Mon, Wed at 08:30"
    assert describe("@daily") == "Daily at 00:00"
    week = upcoming("0 9 * * 1-5", now)
    assert week and all(t.isoweekday() <= 5 for t in week)
    either = upcoming("0 0 1 * 1", now, days=40)  # 1st of the month OR Mondays
    assert any(t.day == 1 for t in either) and any(t.isoweekday() == 1 and t.day != 1 for t in either)
    for bad in ("61 * * * *", "* * *", "0 0 * * 9", "*/0 * * * *"):
        try:
            parse_cron(bad)
            upcoming(bad, now)
        except ValueError:
            continue
        raise AssertionError("accepted bad cron: " + bad)
    assert schedule_fields("not a cron")["schedule"] == "not a cron"
    assert "secret" not in redact("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789secret'")
    routine = slim_routine({"id": "trig_1", "name": "x", "cron_expression": daily, "enabled": True,
                            "session_request": {"environment_variables": {"KEY": "secret"}},
                            "job_config": {"token": "secret"}, "derived_state": {"prompt": "p"}})
    assert "secret" not in json.dumps(routine) and routine["prompt"] == "p"
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "SKILL.md"
        f.write_text("---\nname: demo\ndescription: >\n  first line\n  second\n---\nbody\n", encoding="utf-8")
        assert frontmatter(f) == {"name": "demo", "description": "first line second"}
    auto = {"id": "trig_1", "prompt": "Intro\n1. Search Gmail for job mail.\n2) Write the report, short."}
    steps, source, digest = flow_steps(auto, {})
    assert source == "auto" and [s["label"] for s in steps] == ["Search Gmail for", "Write the report"], steps
    saved = {"trig_1": {"hash": digest, "steps": [{"label": "Search Gmail", "sub": "last 26 h"}]}}
    assert flow_steps(auto, saved)[:2] == ([{"label": "Search Gmail", "sub": "last 26 h"}], "claude")
    assert flow_steps(dict(auto, prompt="changed"), saved)[1] == "auto"  # stale labels are dropped
    assert inline_safe('a="</script><!--"') == 'a="<\\/script><\\!--"'
    assert tool_label("Edit", {"file_path": str(HOME / "x" / "pages.jsx")}) == "Edit pages.jsx"
    assert tool_label("Bash", {"command": "curl -H 'Bearer abcdefghijklmnopqrstuvwxyz0123456789'"}).endswith("•••'")
    assert tool_label("mcp__abc__list_events", {}) == "MCP list_events"
    with tempfile.TemporaryDirectory() as d:
        f = Path(d) / "t.jsonl"
        rows = [{"type": "user", "timestamp": "1", "message": {"content": "fix the bug"}},
                {"type": "assistant", "timestamp": "2", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/a/b.py"}}]}},
                {"type": "user", "timestamp": "3", "toolUseResult": {}, "message": {"content": [{"type": "tool_result"}]}},
                {"type": "assistant", "timestamp": "4", "message": {"content": [{"type": "text", "text": "Done."}]}}]
        f.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
        evs, ctx, _ = tail_events(f)
        assert [e["label"] for e in evs] == ["Reply", "Read b.py", "Your prompt"] and ctx == 0, evs
    opus = {"input_tokens": 1_000_000, "output_tokens": 1_000_000, "cache_read_input_tokens": 1_000_000,
            "cache_creation_input_tokens": 3_000_000, "cache_creation": {"ephemeral_1h_input_tokens": 1_000_000}}
    assert abs(message_cost("claude-opus-5-5", opus) - (4 + 20 + 0.20 + 2 * 4 * 1.25 + 4 * 2)) < 1e-9
    assert message_cost("claude-opus-5", {"output_tokens": 1_000_000}) == 25  # not matched as opus-5-5
    assert message_cost("claude-opus-5-5", dict(opus, speed="fast")) == 2 * message_cost("claude-opus-5-5", opus)
    assert message_cost("gpt-x", opus) is None
    assert context_window("claude-haiku-4-5") == 200_000 and context_window("claude-opus-5-5") == 1_000_000
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description="Build the Claude Pit dashboard from your Claude setup.")
    ap.add_argument("--routines", metavar="FILE", help="RemoteTrigger `list` result to import")
    ap.add_argument("--selftest", action="store_true", help="run the built-in checks and exit")
    ap.add_argument("--live", action="store_true", help="print running sessions as JSON and exit (used by the desktop app)")
    ap.add_argument("--search", metavar="TEXT", help="print sessions whose messages contain TEXT as JSON and exit")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if args.live:
        return print(json.dumps(live_sessions(), ensure_ascii=False, separators=(",", ":")))
    if args.search is not None:
        return print(json.dumps(search_transcripts(args.search), ensure_ascii=False, separators=(",", ":")))
    data = collect(args.routines)
    page, changed = build(data)
    counts = ", ".join("%d %s" % (len(data[k]), k) for k in
                       ("automations", "hooks", "plugins", "mcp", "skills", "agents", "commands"))
    print("Built %s: %s; %d sessions in %d days" % (page, counts, data["activity"]["totals"]["window_sessions"],
                                                   data["activity"]["window"]))
    print("library.json changed" if changed else "library.json unchanged")
    for msg in new_alerts(data["automations"], data["health"]):
        print("ALERT: " + msg)
    for a in data["automations"]:
        if a["steps_source"] == "auto" and a.get("prompt"):
            print("needs step labels: %s %s (prompt hash %s)" % (a["id"], a["name"], a["prompt_hash"]))


if __name__ == "__main__":
    main()
