# Claude Pit

A dashboard for your whole Claude setup: what runs on a schedule and how each automation flows, what Claude Code has been doing, and every skill, plugin, MCP server, agent and hook you have, for both Claude Code and Claude (claude.ai).

It opens as a private Claude artifact on your Mac and your phone, or as one HTML file in any browser.

## Pages

| Page | What it shows |
| --- | --- |
| **Overview** | Sessions working right now, counts, this month's cost, plan limits, next run with a countdown, cost per day, skills and MCP mix, health |
| **Live** | Claude Code sessions open now: working or waiting, what each is doing, its last steps, how full its context window is, and recent sessions. Updates every 5 seconds in the desktop app |
| **Events** | Every tool call, prompt, reply and tool error across sessions for the last 7 days, searchable and filterable |
| **Automations** | Each automation as a flow diagram (when → where it runs → steps → result), run history, model, connectors, the full prompt, and **Run now** / **Pause** / **Resume** |
| **Schedule** | A 7-day strip and every upcoming run as a row of boxes: time → automation → what it does → result |
| **Usage & cost** | Plan limits (5-hour and weekly), API-equivalent cost today / this month / 30 days, budget, cost per day and by model, most expensive sessions, top tools, sessions, projects, skills |
| **History** | Every past session with project, model, replies, tools and cost; search titles, or search inside messages in the desktop app |
| **Skills** | Claude Code vs Claude Chat, mix by source, search and filter |
| **Plugins** | Claude Code and claude.ai plugins, with what each one ships |
| **MCP** | claude.ai connectors, plugin servers, local servers and desktop extensions, with sign-in status |
| **Agents** | Subagents and slash commands, searchable |
| **Hooks** | Each hook as event → matcher → command |
| **Memory** | Your CLAUDE.md files and Claude's auto-memory notes; open one to read it in the desktop app |
| **Health** | Failed or paused schedules, budget, plan limits, full context windows, tool errors, sign-ins, stale data |
| **Settings** | Monthly budget, live updates, menu bar item, notifications, refresh |

Also: left sidebar navigation, phone layout with a drawer, light and dark themes, and a refresh task that keeps it current.

### In the desktop app

In a browser or on your phone the page shows the last snapshot. Install it as an app from the Claude desktop app (*Install as app*) and it can do more:

- **Live updates**: press **Turn on live updates** and allow *full access*. The app runs `python3 collect.py --live` every 5 seconds (read only, fixed arguments, no shell). The desktop app asks again after each new published version, which a refresh creates.
- **Menu bar item**: working sessions or the next run time at the top of the screen, with a menu of cost and plan limits. It keeps updating every 30 seconds while the window is hidden.
- **Notifications**: when a session finishes or needs you, a run fails, or the month passes your budget.
- **Read memory files** and **search inside past messages**, both read straight from your disk.

### Cost and alerts

Cost is **API-equivalent**: what the same tokens would cost at Anthropic's API list prices, with cache writes (1.25x or 2x input) and cache reads priced per model. On a Pro or Max plan you pay a fixed price, so treat it as a gauge of use. Set a monthly budget in Settings; Health warns at 80% and 100%, and the scheduled refresh sends a push notification once per new failed run or budget crossing.

### Run, pause and resume

Buttons on each automation copy a command such as `/claude-pit run trig_…`. Paste it in Claude Code: the `claude-pit` skill runs, pauses or resumes the routine or desktop task with its own tools, then refreshes the page. `/claude-pit budget 50` sets the budget the same way.

## Stack

- **React 18** (loaded from cdnjs) with JSX in `src/`, bundled by **esbuild**. No other runtime dependency.
- **`collect.py`**: Python 3.9+ standard library only. Reads your Claude config and transcripts and writes the data files.
- No server and no database. The page is static: `out/index.html` plus `app.js`, `app.css`, `data.json` (changes daily) and `library.json` (changes when you install things).
- Look and feel: the [diagram-design](https://github.com/cathrynlavery/diagram-design) skin (Instrument Serif, Geist, Geist Mono; white-smoke paper, jet-black ink, one burnt-tangerine accent). Chart colours pass a colour-blind safety check.

```
src/main.jsx      app shell: data loading, sidebar, routing
src/pages.jsx     one component per page
src/ui.jsx        cards, pills, meters, charts (donut, bars), flow diagrams, icons
src/styles.css    design tokens and layout
shell.html        the page the artifact serves
collect.py        collector and builder
skill/SKILL.md    the /claude-pit refresh skill
```

## Quick start

Local only (no cloud routines, no artifact):

```bash
git clone https://github.com/Iwadss/claude-pit.git
cd claude-pit
python3 collect.py
open out/claude-pit.html
```

`build/` is committed, so you need Node only to change the UI. For a fully offline page run `npm install` once; the one-file build then inlines React.

## Full setup with Claude Code

Install the refresh skill:

```bash
mkdir -p ~/.claude/skills/claude-pit
sed "s#<PIT_DIR>#$PWD#g" skill/SKILL.md > ~/.claude/skills/claude-pit/SKILL.md
```

Then type `/claude-pit` in Claude Code. Claude pulls your cloud routines, run history, desktop scheduled tasks and claude.ai skills, rebuilds, and publishes the page as a private artifact. The link is saved in `cache/artifact_url.txt`, and later runs update the same link.

To keep it fresh, ask Claude Code for a scheduled task, for example *"Create a scheduled task that runs /claude-pit every day at 8:00 and 20:00."* Scheduled tasks run while the Claude app is open; a missed run starts at the next launch. Each run uses some of your Claude usage.

## Change the UI

```bash
npm install
npm run watch      # rebuilds build/app.js on save
python3 collect.py # writes out/
```

## What it reads

| Source | Used for |
| --- | --- |
| `~/.claude/settings.json` | enabled plugins, hooks, default model |
| `~/.claude/plugins/…` | Claude Code plugins and their skills, commands, agents, hooks, MCP servers; claude.ai plugins synced to your computer |
| `~/.claude/skills`, `agents`, `commands` | your own skills, agents, slash commands (plus synced Anthropic skills) |
| `~/.claude.json` | MCP servers, connectors seen by Claude Code, project folders, skill use counts |
| `~/.claude/projects/*/*.jsonl` | usage and cost per day, model and session; events; history; the last steps and context size of open sessions |
| `~/.claude/projects/*/memory/*.md`, `CLAUDE.md` files | Memory page (names and descriptions; content is read only inside the desktop app) |
| `~/Library/Application Support/Claude/plan-usage-history.json`, `cache/plan_usage.json` | plan limits |
| `~/.claude/sessions/*.json`, `~/Library/Application Support/Claude/claude-code-sessions` | sessions open right now and their state; recent desktop app sessions |
| `<project>/.claude/…`, `<project>/.mcp.json` | project skills, agents, commands, hooks, MCP servers |
| `~/.claude/mcp-needs-auth-cache.json` | servers waiting for sign-in |
| `~/Library/Application Support/Claude/…` | desktop app extensions (enabled flag only) |
| `~/Library/LaunchAgents`, `crontab -l` | local jobs that run the `claude` CLI |
| `cache/*.json` (written by `/claude-pit`) | cloud routines, run history, desktop scheduled tasks, your claude.ai skills, flow step labels |

## Privacy and security

- Never copied: env vars, headers, tokens, MCP commands and arguments, URL paths. Hook commands are shortened, the home folder becomes `~`, and anything shaped like a key is blanked.
- Usage keeps counts and project folder names. Live, Events and History keep session titles, tool names, file names and each command's one-line description. None of them keeps message text. Memory publishes file names and one-line descriptions; file contents and message search stay on your computer (desktop app only).
- `cache/` and `out/` hold your data and are in `.gitignore`. Do not commit them.
- Routine prompts are shown in full. Artifacts are private by default; share the page only with people who may read your prompts.
- The collector only reads your Claude config. It never changes it.

## Ideas from other Claude dashboards

Features people have built into Claude Code dashboards and monitors, and where Claude Pit stands:

| Feature | Seen in | Claude Pit |
| --- | --- | --- |
| Token usage per day, model, project | ccusage, Claude Code Usage Monitor, claude-code-templates | Yes |
| Cost in dollars, monthly budget alert | ccusage, Usage Monitor | Yes (API-equivalent) |
| Live view of running sessions and tool calls | claude-code-templates, hooks observability dashboards | Yes (live in the desktop app) |
| Event stream of every tool call | multi-agent observability dashboards | Yes (read from transcripts, no hooks needed) |
| Session history browser and search | Claudia/opcode, Claude Code UI | Yes (message search in the desktop app) |
| Agents, commands, MCP browser | claude-code-templates, Claudia | Yes |
| Schedules, run history, flow diagrams | automation dashboards (n8n style) | Yes |
| Run now, pause, resume | automation dashboards | Yes (through `/claude-pit`) |
| Alerts for failed runs and budget | automation dashboards | Yes (Health, desktop notification, push from refresh) |
| Context window and plan limit usage | status lines, Usage Monitor | Yes |
| CLAUDE.md and memory viewer | Claudia/opcode | Yes |
| Menu bar widget | desktop monitors | Yes (desktop app) |

## Limits

- "Needs sign-in" comes from Claude Code's last connection check, not a live test.
- Usage, cost, events and history cover Claude Code on this computer only; claude.ai chats and cloud runs are not in them.
- Prices are a static table in `collect.py` (`PRICES`); update it when Anthropic's prices change.
- Plan limits are as fresh as the last refresh, or the desktop app's own last sample.
- launchd jobs are found by a `claude` command in their arguments; a wrapper script that calls `claude` inside is missed.

## Checks

```bash
python3 collect.py --selftest
python3 collect.py --live    # what the desktop app polls
```

## License

MIT. Not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.
