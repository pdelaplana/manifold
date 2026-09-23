# Manifold

A small Windows desktop app for running several Claude Code sessions at once. Sessions live in a side panel with a live status, and the app tells you when one of them is blocked on you.

## Run it

You need Node.js 20 or newer and Claude Code installed so that `claude` works in PowerShell.

```powershell
npm install
npm start
```

`@lydell/node-pty` ships prebuilt Windows binaries, so you don't need Visual Studio build tools. To build an installer, run `npm run dist`. The installer lands in `dist\`.

## Using it

Press **New session** (or Ctrl+Shift+N), pick a project folder, and choose how Claude should start. Each session runs `claude` inside its own PowerShell, and PowerShell stays open if Claude exits so you can rerun it by hand.

The side panel shows each session's state:

| State | Meaning |
|---|---|
| Working | Claude is running tools or writing a reply |
| Needs you | Claude is waiting for a permission decision (amber, pulses) |
| Your turn | Claude finished its turn and is waiting for your next prompt |
| Claude exited | Claude quit; the PowerShell prompt is still live |
| Stopped | The shell itself closed. Use Restart |

When a session reaches **Needs you** or finishes a turn while you're looking at another session or another window, you get a Windows notification and the taskbar button flashes. Clicking the notification jumps to that session.

Rename a session by clicking its name in the top bar. **Restart** stops the session and resumes the same conversation.

### Keyboard

| Keys | Action |
|---|---|
| Ctrl+Shift+N | New session |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous session |
| Ctrl+Shift+1 … 9 | Jump to session 1–9 |
| Ctrl+C with a selection, or Ctrl+Shift+C | Copy |
| Ctrl+V | Paste |
| Shift+Enter | New line in the Claude prompt |

## Settings

Settings live in `%APPDATA%\Manifold\settings.json`. The **Edit settings** link opens it.

```json
{
  "fontSize": 13,
  "fontFamily": "\"Cascadia Mono\", \"Cascadia Code\", Consolas, monospace",
  "lineHeight": 1.15,
  "presets": [
    { "id": "fresh", "name": "New conversation", "args": [] },
    { "id": "continue", "name": "Continue last conversation in this folder", "args": ["--continue"] },
    { "id": "start-dev", "name": "Start dev (/start-dev)", "args": [], "prompt": "/start-dev" },
    { "id": "start-triage", "name": "Start triage (/start-triage)", "args": [], "prompt": "/start-triage" },
    { "id": "opus-plan", "name": "Opus in plan mode", "args": ["--model", "opus", "--permission-mode", "plan"] }
  ]
}
```

`fontSize`, `fontFamily` and `lineHeight` set the terminal text. When you save the file, all open terminals update. `fontSize` must be from 6 to 72, and `lineHeight` must be from 1 to 3. If a value is missing or out of range, the app uses the default.

`presets` are the launch presets in the new-session dialog. Changes apply to the next session you create. `args` are passed straight to `claude`. `prompt` is sent as the opening message.

## Restoring sessions

The session list is saved to `%APPDATA%\Manifold\workspace.json`. On relaunch every session comes back and resumes its own conversation with `claude --resume <id>`. The app learns each conversation's id from Claude's hooks, so two sessions in the same folder don't collide. A session that never reached Claude falls back to `--continue`. Terminal scrollback is not restored. The conversation is.

## How status works

The app doesn't guess from terminal output. Each session is started with `claude --settings <file>`, where the file adds hooks for `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `Notification`, `Stop` and `SessionEnd`. Each hook runs Windows' built-in `curl.exe` to post the event to a listener on `127.0.0.1` that only accepts requests carrying a random per-launch token. Your own `~/.claude/settings.json` is never modified, and hooks you already have keep running alongside these.

If statuses never change from Starting, check that `curl.exe` runs in PowerShell. Also run `/hooks` inside a session to confirm the extra hooks were loaded.

## Files

```
src/main.js        Main process: terminals, hook listener, notifications, persistence
src/preload.js     Safe bridge between the window and the main process
renderer/          Side panel, terminal view and new-session dialog
```
