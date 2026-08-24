# pi-retitle

Model-generated session titles for pi.

`pi-retitle` watches the first user prompt in a TUI session and asks a temporary `pi-extended-teams` helper agent to generate a short title. It then updates the Pi session name, the TUI title, the Herdr pane label when running inside Herdr, and the tmux window name when running inside tmux.

## Dependency

`pi-retitle` requires [`pi-extended-teams`](https://github.com/dantetekanem/pi-extended-teams). Both packages live under `github.com/dantetekanem`.

Install `pi-extended-teams` first so its orchestration events are available, then install `pi-retitle`:

```bash
pi install git:github.com/dantetekanem/pi-extended-teams
pi install git:github.com/dantetekanem/pi-retitle
```

## What it does

- Sets new sessions to `pi - new session` until a prompt is available.
- Generates one lower-case title from the first prompt.
- Applies the title as `pi - <title>` to Pi's session name and TUI title.
- Shows `pi #<sidebar position> - <title>` in the Herdr pane border when `HERDR_ENV=1`, tracking the pane's current position in Herdr's Agents sidebar.
- Renames the active tmux window when `TMUX` is present.
- Restores the plain `pi` title and clears its Herdr pane metadata on session shutdown.

## Notes

- Title generation runs only in Pi TUI mode.
- The helper agent uses the read-only `reading-fast` model slot through `pi-extended-teams`.
- If `pi-extended-teams` is not installed and loaded, title generation cannot complete.
- In Herdr, the sidebar position refreshes once per second and follows the configured `ui.agent_panel_sort` order.
