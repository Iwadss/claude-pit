# Claude Pit

A dashboard for your whole Claude setup: what runs on a schedule and how each automation flows, what Claude Code has been doing, and every skill, plugin, MCP server, agent and hook you have, for both Claude Code and Claude (claude.ai).

It opens as a private Claude artifact on your Mac and your phone, or as one HTML file in any browser.

## Pages

| Page | What it shows |
| --- | --- |
| **Overview** | Counts, next run with a live countdown, sessions over 14 days, skills and MCP mix, health summary |
| **Automations** | Each automation as a flow diagram (when → where it runs → steps → result), schedule, next run, run history, model, permissions, connectors, full prompt |
| **Schedule** | A 7-day strip and every upcoming run as a row of boxes: time → automation → what it does → result |
| **Activity** | Sessions and output tokens per day, tokens by model, top projects, most used skills (from local Claude Code transcripts) |
| **Skills** | Claude Code vs Claude Chat, mix by source, search and filter |
| **Plugins** | Claude Code and claude.ai plugins, with the skills, commands, agents, hooks and MCP servers each one ships |
| **MCP** | claude.ai connectors, plugin servers, local servers and desktop extensions, with sign-in status |
| **Agents** | Subagents and slash commands, searchable |
| **Hooks** | Each hook as event → matcher → command |
| **Health** | Failed or paused schedules, connectors waiting for sign-in, hooks that run on every prompt, duplicate skills, stale data |

Also: left sidebar navigation, phone layout with a drawer, light and dark themes, *Install as app* inside the Claude desktop app, and a refresh task that keeps it current.

## Stack

- **React 18** (loaded from cdnjs) with JSX in `src/`, bundled by **esbuild**. No other runtime dependency.
- **`collect.py`**: Python 3.9+ standard library only. Reads your Claude config and transcripts and writes the data files.
- No server and no database. The page is static: `out/index.html` plus `app.js`, `app.css`, `data.json` (changes daily) and `library.json` (changes when you install things).
- Look and feel: the [diagram-design](https://github.com/cathrynlavery/diagram-design) skin (Instrument Serif, Geist, Geist Mono; white-smoke paper, jet-black ink, one burnt-tangerine accent). Chart colours pass a colour-blind safety check.

```
src/main.jsx      app shell: data loading, sidebar, routing
src/pages.jsx     one component per page
src/ui.jsx        cards, pills, charts (donut, bars), flow diagrams, icons
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
| `~/.claude/projects/*/*.jsonl` | activity: sessions, replies and tokens per day, models, projects |
| `<project>/.claude/…`, `<project>/.mcp.json` | project skills, agents, commands, hooks, MCP servers |
| `~/.claude/mcp-needs-auth-cache.json` | servers waiting for sign-in |
| `~/Library/Application Support/Claude/…` | desktop app extensions (enabled flag only) |
| `~/Library/LaunchAgents`, `crontab -l` | local jobs that run the `claude` CLI |
| `cache/*.json` (written by `/claude-pit`) | cloud routines, run history, desktop scheduled tasks, your claude.ai skills, flow step labels |

## Privacy and security

- Never copied: env vars, headers, tokens, MCP commands and arguments, URL paths. Hook commands are shortened, the home folder becomes `~`, and anything shaped like a key is blanked.
- Activity keeps only counts and project folder names, never message text.
- `cache/` and `out/` hold your data and are in `.gitignore`. Do not commit them.
- Routine prompts are shown in full. Artifacts are private by default; share the page only with people who may read your prompts.
- The collector only reads your Claude config. It never changes it.

## Ideas from other Claude dashboards

Features people have built into Claude Code dashboards and monitors, and where Claude Pit stands:

| Feature | Seen in | Claude Pit |
| --- | --- | --- |
| Token usage per day, model, project | ccusage, Claude Code Usage Monitor, claude-code-templates | Yes (tokens, not cost) |
| Cost in dollars, monthly budget alert | ccusage, Usage Monitor | Not yet |
| Live view of running sessions and tool calls | claude-code-templates, hooks observability dashboards | Not yet |
| Hook event stream (every PreToolUse/PostToolUse) | multi-agent observability dashboards | Not yet; hooks are listed |
| Session history browser and search | Claudia/opcode, Claude Code UI | Not yet |
| Agents, commands, MCP browser | claude-code-templates, Claudia | Yes |
| Schedules, run history, flow diagrams | automation dashboards (n8n style) | Yes |
| Run now, pause, resume buttons | automation dashboards | Not yet (ask Claude) |
| Notifications before or after runs, failure alerts | automation dashboards | Not yet |
| Context window and rate-limit usage | status lines, Usage Monitor | Not yet |
| CLAUDE.md and memory viewer | Claudia/opcode | Not yet |
| Menu bar widget | desktop monitors | Not yet |

## Limits

- "Needs sign-in" comes from Claude Code's last connection check, not a live test.
- Activity covers Claude Code on this computer only; claude.ai chats and cloud runs are not in it.
- launchd jobs are found by a `claude` command in their arguments; a wrapper script that calls `claude` inside is missed.

## Checks

```bash
python3 collect.py --selftest
```

## License

MIT. Not affiliated with or endorsed by Anthropic. Claude is a trademark of Anthropic.
