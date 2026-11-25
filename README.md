# Kokpit Claude

One page that shows your whole Claude setup: what runs on a schedule, when it runs next, how each automation flows, and every plugin, MCP server, connector, skill, agent and hook you have, for both Claude Code and Claude (claude.ai).

*Kokpit* is Malay for cockpit. The page borrows from one: the type is B612 (the typeface Airbus designed for cockpit screens), upcoming runs sit on a departures board, and status colours follow flight-deck convention: green normal, amber caution, red warning, cyan info.

## What you get

- **Next run** with a live countdown, and a **departures board** of every run in the next 7 days.
- **Automation cards**: schedule in plain words and as cron, time zone, next run, recent runs with status, model, permission mode, notifications, connectors, and the full prompt.
- **A flow diagram per automation** (trigger → where it runs → what it uses → result) and **one for your whole setup** (triggers → Claude → abilities → results).
- **Counts and lists** of plugins, MCP servers and connectors, skills, agents and slash commands, split by Claude Code and Claude Chat.
- **Event hooks** (SessionStart, UserPromptSubmit, PreToolUse…) with the command each one runs.
- **Health checks**: failed or paused schedules, connectors waiting for sign-in, hooks that run on every prompt, duplicate skill names, stale snapshot.
- **Search** across everything (press `/`), skill filter by Claude Code or Claude Chat, light and dark themes, phone layout.
- **Install as app**: inside the Claude desktop app the page offers its own window and Dock icon.

## How it works

```
~/.claude, ~/.claude.json, Claude desktop app config ─┐
cloud routines + run history (via the /kokpit skill) ──┼─► collect.py ─► dist/kokpit.html ─► private Claude artifact
                                                       │                 dist/kokpit-local.html ─► any browser, offline
                                                       └─ secrets stripped
```

`collect.py` uses only the Python standard library (3.9+). The page is one HTML file with the data inside it, so it works as a local file and as a [Claude artifact](https://claude.ai), which you can open on your Mac and your phone.

Cloud routines (Cowork scheduled tasks and `/schedule` routines) live on claude.ai, so a script cannot read them on its own. The `/kokpit` skill asks Claude Code to fetch them with its built-in tools, then runs the collector and republishes the page.

## Quick start

Local only (no routines, no artifact):

```bash
git clone https://github.com/Iwadss/kokpit-claude.git
cd kokpit-claude
python3 collect.py
open dist/kokpit-local.html
```

Full setup with Claude Code (adds cloud routines and a private page you can open anywhere):

```bash
mkdir -p ~/.claude/skills/kokpit
sed "s#<KOKPIT_DIR>#$PWD#g" skill/SKILL.md > ~/.claude/skills/kokpit/SKILL.md
```

Then type `/kokpit` in Claude Code. The first run publishes the page and saves its link in `cache/artifact_url.txt`; later runs update the same link.

To keep it fresh by itself, ask Claude Code for a scheduled task, for example: *"Create a scheduled task that runs /kokpit every day at 7:00."* Each run uses some of your Claude usage.

## What it reads

| Source | Used for |
| --- | --- |
| `~/.claude/settings.json` | enabled plugins, hooks, default model |
| `~/.claude/plugins/installed_plugins.json` and each plugin folder | Claude Code plugins and their skills, commands, agents, hooks, MCP servers |
| `~/.claude/plugins/synced`, `~/.claude/skills/synced` | claude.ai plugins and Anthropic skills synced to your computer |
| `~/.claude/skills`, `agents`, `commands` | your own skills, agents, slash commands |
| `~/.claude.json` | user and project MCP servers, connectors seen by Claude Code, project folders |
| `<project>/.claude/…`, `<project>/.mcp.json` | project skills, agents, commands, hooks, MCP servers |
| `~/.claude/mcp-needs-auth-cache.json` | which servers wait for sign-in |
| `~/Library/Application Support/Claude/…` | desktop app extensions (enabled flag only) |
| `~/Library/LaunchAgents`, `crontab -l` | local jobs that run the `claude` CLI |
| `cache/*.json` (written by `/kokpit`) | cloud routines, run history, desktop scheduled tasks, your claude.ai skills |

## Privacy and security

- Never copied: env vars, headers, tokens, MCP commands and arguments, URL paths. Hook commands are shortened, the home folder becomes `~`, and anything shaped like a key is blanked.
- `cache/` and `dist/` hold your data and are in `.gitignore`. Do not commit them.
- Routine prompts are shown in full. Artifacts are private by default; share the page only with people who may read your prompts.
- The collector only reads. It never changes your Claude config.

## Limits

- "Needs sign-in" comes from Claude Code's last connection check, not a live test.
- launchd jobs are found by a `claude` command in their arguments; a wrapper script that calls `claude` inside is missed.
- Desktop scheduled tasks and custom claude.ai skills appear only after a `/kokpit` run.

## Checks

```bash
python3 collect.py --selftest
```

## License

MIT. Not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.
