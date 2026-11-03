# Skills Panel

Herdr's main layout with a third right-hand panel, **Skills**, next to Files and Changes: it lists the Claude Code skills the focused pane's session has loaded, newest first, with how often, when, and the arguments each use was given. The tab bar's panel buttons can be dragged into any order (a ghost follows the pointer, a dashed slot shows where it lands, the others slide aside), removed and restored from a right-click menu, and `cmd-shift-b` shows or hides the right panel.

![Skills Panel](preview.png)

## What you see

- **Tab bar, right end:** after the `+` button, the panel buttons `Files`, `Skills`, `Changes` (default order), each 26px tall, 8px side padding, 5px icon gap, 6px radius, 12px text, 14px icon, 3px apart. The open panel's button has the `selected` background and `foreground` text; the others `chrome` and `muted`.
- **Right panel** (the shipped `panel` column: 368px, min 280, max 900, hidden by default): a stack of `files`, `skills`, `changes`.
- **Skills panel**, a rounded card (10px, `background`, 1px `border`):
  - Header, 42px: `Skills` semibold, a `N skills` badge (10px text, bordered), and `N loads` on the right in `dim`.
  - A session line, 11px `dim`: `session <name> · <first 8 of session id>`.
  - One 30px row per skill: a 12px chevron, the skill name (truncated), a source tag (`project` in `accent`, `user` / `plugin` in `muted`), `×N` when used more than once, and how long ago it was last used (`now`, `5m`, `2h`, `1d`) right-aligned in 30px.
  - A row expanded shows one card per use, newest first (6px padding, `raised`): `HH:MM`, `agent called` or `typed /command`, `sub-agent` in `blocked` when a sub-agent loaded it, and the arguments (first 400 characters, `no arguments` in `dim` when empty).
  - Empty states: `Focus a Claude Code pane`, `No Claude Code session in this pane`, `Remote terminals aren't tracked yet`, `Session file not found yet`, `No skills used in this session yet`.
- **Panel-button menu** (right-click), a 200px popup: `Remove <panel>` with a close icon, a 1px divider, then every panel in bar order with its icon and an `accent` check mark when shown. Rows 31px, 12.8px text, 7px radius, 5px menu padding, `popover` background.

## How it behaves

- **Skills data** follows the focused pane (falling back to the focused pane's terminal, then the agent an agent block shows; it keeps the last one while focus is on a panel). It refreshes every 4 s and reads only the part of the transcript added since the last read. A new session id under the same process (`/clear`, resume) starts the list over.
- **Click** a skill row: expand or collapse it.
- **Click** a panel button: open that panel, or hide the panel when it's already the open one. Which panel is open is remembered per space (the shipped `tabs` behaviour).
- **Drag** a panel button (starts after 4px of movement): the button becomes a ghost under the pointer (85% opacity, `raised`, `input` border, medium shadow, grabbing cursor); a dashed `accent` slot with the `hover` background sits where it will land; the other buttons slide to make room (`left`, 140 ms, ease-out). The slot is the position whose centre is nearest the ghost's centre, so it doesn't flicker at boundaries. Release drops it there; leaving the tab bar mid-drag drops it at the current slot. The order persists.
- **Right-click** a panel button: the menu opens with its top-left 2px right of the pointer and 6px below the button. `Remove` hides that button (and closes its panel if open); a checked row hides that panel's button, an unchecked one restores it. Right-click empty tab-bar space for the same menu without `Remove`. Nothing is highlighted until hover or ↑/↓; Enter runs, Esc closes.
- **`cmd-shift-b`**: toggle the right panel (`cmd-b` still toggles the left sidebar).

## Built from

- `layouts/my-main.json`: a `layout.clone` of `main` (0.1.12). Changes from `main`: the tab-bar block's `content.mod` is `my-tabs`, and `panel-body` (a `stack`) has children `files`, `skills`, `changes`.
- `mods/my-tabs`: a `mod.clone` of `tabs`. The three panel buttons are drawn from one table (`files`, `skills`, `changes` → label, icon). Order lives in shared `my-tabs.panelOrder`, hidden buttons in shared `my-tabs.panelHidden`; the buttons shown are shared `workspace.panels` (default `["files","changes"]`) plus `skills`, minus hidden ones. Once every button has reported its width (`on_size_change`), the group is a `relative` box of the total width and each button is `absolute` with `.left(x).transition("left", …)`, which is what makes them slide. Drag tracking is `on_mouse_move` / `on_mouse_up` / `on_hover(false)` on the tab bar root. Right-click opens `panel-menu` with `openOverlay({ kind: "popup", width: 200, at: { x, y } })`. Commands: `layout.select {stack: "panel-body", child}`, `layout.show` / `layout.hide {id: "panel"}`.
- `mods/panel-menu`: the popup. Writes `my-tabs.panelHidden` with `setShared`; uses `mods/pane/close.svg` and `mods/workspace-chrome/check.svg` (shipped).
- `mods/skills`: the panel (`main.js`) and `scan.py`. Per refresh: `hc get <terminal> --json` → `foreground.pid` (only when `foreground.argv[0]` is `claude`) → `python3 -I scan.py <pid> '<offsets json>'`. `scan.py` reads `~/.claude/sessions/<pid>.json` for `sessionId` and `cwd`, opens `~/.claude/projects/<cwd with every non-alphanumeric as "-">/<sessionId>.jsonl` (else searches `~/.claude/projects/*/<sessionId>.jsonl`) and its `subagents/**/*.jsonl`, and returns new events plus per-file byte offsets. Events: a **load** is a `type: "user"`, `isMeta: true` message whose text starts `Base directory for this skill: <dir>` (one per skill use, typed or called); a **call** is an assistant `tool_use` named `Skill` (gives `skill` and `args`, joined to the load by `sourceToolUseID`); a **slash** is a user message with `<command-name>` / `<command-args>` (args for a typed use). Skill name: the call's `skill`, else the typed command, else the folder's basename. Source: the folder contains `/plugins/` → plugin; under `~/.claude/skills` or `~/.agents/skills` → user; otherwise project.
- `keys.json`: `"global": { "cmd-shift-b": "layout.toggle:panel" }`.
- Icons: `mods/skills/skills.svg` (a star, 24×24, stroke `currentColor` 1.5); the other buttons reuse `mods/files/file.svg` and `mods/changes/changes.svg`.

## Watch out

- **It reads outside its folder and runs programs:** `hc`, `python3`, and files under `~/.claude/sessions` and `~/.claude/projects`, which hold your Claude Code transcripts. It sends nothing anywhere. It needs `python3` on the PATH Herdr's `exec` sees.
- Herdr's shipped layouts and mods are replaced on every start: clone `main` and `tabs` and edit the clones.
- Write `mod.json` (`{ "place": "none" }`) **before** the new folder appears under `mods/`. Herdr docks a mod it sees with no `mod.json` into the shown layout's root as a 320px column.
- `on_size_change` reports widths with the app's zoom applied; divide by `settings().zoom` before using them as `.left()` / `.w()` values, or the buttons spread apart at any zoom other than 1.
- Mouse-event units may differ from layout units too: the drag converts the pointer delta with the ratio of the pressed button's `event.bounds.width` to its measured width.
- `focused().terminal` can be null while a pane is focused; fall back to `panes().find(p => p.pane === focused().pane)?.terminal`.
- Don't match transcript text with a plain search: tool outputs can quote the `Base directory for this skill:` marker. Parse each JSON line and check `type` and `isMeta`.
- The transcript layout is Claude Code's (checked against 2.1.317), not a public contract; a format change shows as an empty list, not an error.
- `on_mouse_move` fires only while the tab bar is hovered, so a release outside it is never seen; the drag ends (and drops) when the pointer leaves the bar.
- Local terminals only. Codex and other agents aren't read.

## Done when

- `herdr-app check` passes for `mods/my-tabs`, `mods/skills` and `mods/panel-menu`, and `herdr-app status` shows no errors with `my-main` selected.
- The tab bar shows `Files`, `Skills`, `Changes`; clicking `Skills` opens the panel on Skills, and clicking it again hides the panel.
- With a Claude Code pane focused that has used a skill, the list shows it with the right source tag and age; using another skill in that pane adds or moves it to the top within about 4 s; a shell pane shows `No Claude Code session in this pane`.
- Dragging `Changes` onto the left of `Files` shows the ghost and dashed slot, `Files` slides right, and after release the order stays after a restart.
- Right-clicking `Skills` opens the menu below the button, clear of the pointer; `Remove Skills` hides it, and right-clicking the bar's empty space and checking `Skills` brings it back.
- `cmd-shift-b` hides and shows the right panel.
