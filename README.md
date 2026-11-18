# GitHub Notifications

Your unread GitHub notifications in an Orca sidebar panel, like
[github.com/notifications](https://github.com/notifications?query=is%3Aunread), with review
requests first.

## Features

- Lists every unread notification (follows GitHub's pagination, up to 500; the count shows `500+`
  beyond that). Polls every 30 seconds, also with no panel open.
- Grouped by repository or by type (review requested, mentions, assigned, ...). Review requests,
  mentions and assignments start expanded. Big groups show 25 rows at a time with a
  "Show more" button.
- Each row shows the pull request's state (Open, Draft, Merged, Closed) and its author. They are
  looked up from GitHub a few at a time and remembered.
- **Mark as done** hides the thread at once and sends it to GitHub after 5 quiet seconds, so an
  **Undo** bar can bring back a slip. (GitHub cannot mark a thread unread again, which is why the
  send is delayed.) **Mark all read** asks for confirmation.
- **Open** a thread on GitHub from its row.
- **Orca worktrees:** a pull request that already has a worktree in Orca shows its name and a
  button to go there; one from a repo Orca knows gets a button to review it in a new worktree
  (fetches the PR head and creates a linked worktree). Needs the `orca` CLI.
- A `...` menu in the panel: **Show** (all or reviews only), **Group by** (repo or type),
  **Refresh** and **Mark all read**. Choices are
  remembered.
- Errors from GitHub or the worker show in a red box at the top.

## Desktop notifications

New threads trigger an Orca desktop notification. Pick which kinds in Orca's Settings, under this
plugin:

| Setting | Default |
|---|---|
| Notify on review requests | on |
| Notify on mentions (you and your teams) | on |
| Notify on assignments | off |
| Notify on comments | off |
| Notify on CI activity | off |

The first poll after install only records what is already there, so the backlog is not announced.
A thread that updates again notifies again.

## Authentication

The worker uses your own GitHub token, looked up in this order:

1. `GH_TOKEN`
2. `GITHUB_TOKEN`
3. `gh auth token` (the [GitHub CLI](https://cli.github.com/), if you are logged in with it)

The token needs the `notifications` scope (`gh auth login` grants it; classic tokens need it
ticked). It is only sent to `api.github.com` and is never stored or logged by the plugin.

## Access this plugin asks for

Requires Orca 1.4.248 or later (the panel uses `Box`).

It is a `trusted-worker` plugin: its worker runs as a Node process with your user's permissions,
because it calls the GitHub API and runs `gh auth token` and the `orca` and `git` CLIs for the
worktree features. It also asks to store its own data, show notifications and read its own
settings. Read `src/worker.ts` before approving;
it is one file.

## Develop

```sh
orca plugin validate .
orca plugin test .
orca plugin check .
tsc -p . --noEmit
orca plugin dev load .     # then re-run with --approve <fingerprint>
```

- `src/protocol.ts` declares the panel <-> worker requests and events.
- `src/worker.ts` fetches from GitHub, notifies, queues mark-as-done, and drives the `orca` CLI.
- `src/panel.tsx` is the sidebar panel (no build step).
- `src/node-shim.d.ts` declares the few Node APIs the worker uses, since the plugin has no
  `package.json` to install `@types/node` from.

Docs: [Writing an Orca plugin](https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md).

## License

MIT
