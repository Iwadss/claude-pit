#!/usr/bin/env python3
"""Kokpit: one page that shows your whole Claude setup.

Schedules and routines, event hooks, plugins, MCP servers and connectors,
skills, agents and slash commands, for Claude Code and Claude (claude.ai).

    python3 collect.py                    rebuild dist/ from local config + cached cloud data
    python3 collect.py --routines FILE    also import a RemoteTrigger `list` result
    python3 collect.py --selftest         run the built-in checks

Standard library only, Python 3.9+. Env vars, headers, URL paths, command
arguments and tokens are never copied into the output.
"""
import argparse
import datetime as dt
import json
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
CACHE, DIST = ROOT / "cache", ROOT / "dist"
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


def desktop_auto(t):
    """A Claude desktop app scheduled task, as written to cache/desktop_tasks.json by the /kokpit skill."""
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

    # claude.ai skills: Anthropic's (synced here) and your uploaded ones (cached by /kokpit)
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

    items["mcp"] = connector_rows(routines, cfg, needs) + items["mcp"] + desktop_app_mcp()
    report = health(autos, plugins, items)
    if more:
        report.insert(0, {"level": "caution", "title": "Only the first page of routines was read",
                          "detail": "The routines API said there are more."})
    return {"version": 1, "generated_at": NOW.isoformat(), "routines_synced_at": synced,
            "timezone": local_tz(),
            "settings": {"model": settings.get("model") or "", "effort": settings.get("effortLevel") or ""},
            "automations": autos, "plugins": plugins, **items, "health": report}


SKELETON = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            '</head><body>\n{}\n</body></html>\n')


def build(data):
    """dist/kokpit.html (artifact body), dist/kokpit-local.html (open in any browser), dist/data.json."""
    tpl = (ROOT / "template.html").read_text(encoding="utf-8")
    marker = '"__KOKPIT_DATA__"'
    if tpl.count(marker) != 1:
        raise SystemExit("template.html must contain %s exactly once" % marker)
    page = tpl.replace(marker, json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c"))
    DIST.mkdir(exist_ok=True)
    (DIST / "kokpit.html").write_text(page, encoding="utf-8")
    (DIST / "kokpit-local.html").write_text(SKELETON.format(page), encoding="utf-8")
    (DIST / "data.json").write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    return DIST / "kokpit.html"


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
    print("selftest ok")


def main():
    ap = argparse.ArgumentParser(description="Build the Kokpit page from your Claude setup.")
    ap.add_argument("--routines", metavar="FILE", help="RemoteTrigger `list` result to import")
    ap.add_argument("--selftest", action="store_true", help="run the built-in checks and exit")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    data = collect(args.routines)
    page = build(data)
    counts = ", ".join("%d %s" % (len(data[k]), k) for k in
                       ("automations", "hooks", "plugins", "mcp", "skills", "agents", "commands"))
    print("Built %s (%d KB): %s" % (page, page.stat().st_size // 1024, counts))


if __name__ == "__main__":
    main()
