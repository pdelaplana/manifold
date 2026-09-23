# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

The app is Windows-only. It needs Node.js 20 or newer, and `claude` must run from PowerShell.

```powershell
npm install      # @lydell/node-pty ships prebuilt Windows binaries, no build tools needed
npm start        # electron .
npm run dist     # electron-builder --win nsis, output goes to dist\
```

There are no tests, no linter and no build step for the source. The renderer loads plain scripts and the xterm CSS directly from `node_modules`.

## Architecture

Claude Sessions is an Electron app that runs several Claude Code sessions side by side. It shows a live status for each session.

- `src/main.js` (main process) owns the pseudo-terminals, the hook listener, notifications and persistence. Each session is a `powershell.exe -NoExit -Command "& claude ..."` process in a `node-pty` terminal. PowerShell stays open after Claude exits.
- `src/preload.js` exposes `window.sessions` through `contextBridge`. The window runs with `contextIsolation`, `sandbox` and no Node integration. Every new IPC channel must be added in `main.js` and in `preload.js`.
- `renderer/renderer.js` keeps one xterm `Terminal` per session in the `entries` map. It draws the side panel and handles the app keyboard shortcuts. It holds a copy of each session's state and updates it from `session:status` events.

### How status works

Status comes from Claude Code hooks, not from parsing terminal output. At launch, `main.js` starts an HTTP listener on `127.0.0.1` on a random port, with a random per-launch `HOOK_TOKEN`. For each session, `writeHookSettings` writes `%APPDATA%\Claude Sessions\hooks\<id>.json`, and the session starts with `claude --settings <that file>`. Each hook in `HOOK_STATUS` runs `curl.exe` to POST its payload to `/hook/<token>/<event>/<session id>`. `handleHook` maps the event to a status, sends notifications, and records the payload's `session_id` as `claudeSessionId`. The user's `~/.claude/settings.json` is never changed.

To add a status or react to a new hook event, edit `HOOK_STATUS` in `main.js` and `STATUS_LABEL` in `renderer.js`. The status names are also used as `data-status` values in `styles.css`.

### Persistence and restore

All files live in `app.getPath('userData')`, which is `%APPDATA%\Claude Sessions\`.

- `workspace.json` holds the session list, the active session and the window bounds. It is written atomically (temporary file, then rename).
- `presets.json` holds the launch presets. If the file is missing, `loadPresets` writes the defaults. It ignores entries that are not valid.
- On relaunch, every session restarts with `--resume <claudeSessionId>`. A session with no known id falls back to `--continue`. Terminal scrollback is not restored.
