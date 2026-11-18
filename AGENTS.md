# AGENTS.md

Orca plugin that shows and manages GitHub notifications (review requests, mentions, assignments), like https://github.com/notifications?query=is%3Aunread.

## Layout
- `orca-plugin.json` – manifest (format 2, `trusted-worker`, `pluginApi` 1). Bump `version`, commit, then `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`; `.github/workflows/release.yml` checks the tag matches the manifest and creates the GitHub Release with generated notes.
- `src/protocol.ts` – single source of truth for panel <-> worker requests/events. Edit first when adding features.
- `src/worker.ts` – Node worker: talks to GitHub (REST `/notifications`), stores state in `orca.storage`, runs the `orca`/`git` CLIs for worktrees.
- `src/panel.tsx` – sidebar panel (components UI, no build step).
- `src/*.test.ts(x)`, `src/panel.check.ts` – tests and render scenarios.
- `.orca/types/` – generated typings, git-ignored (`orca plugin types .` to regenerate).

## Commands
- `orca plugin validate .` – manifest check (same as the directory's).
- `orca plugin test .` – run tests.
- `orca plugin check .` – render panel scenarios.
- `npx tsc -p .` – type-check.
- `orca plugin dev watch .` – load into running Orca with live reload (needs `--approve <fingerprint>`).

## Conventions
- Workers lose in-memory state on reload: persist in `orca.storage` (`seenIds`, `threadMeta`).
- User-facing options that the worker needs (notification kinds) are declared in `contributes.settings` and read with `orca.settings` (`settings:own`); panel-only view options are persisted atoms.
- Panel limits: Orca refuses a render over 5000 elements (hence 25 rows per group page); `Image` is not available in every Orca version; `Link` takes only text; a `ListItem` with `onPress` cannot hold other controls; `Badge` has five fixed tones. Mark-as-done updates the panel optimistically.
- Auth: use the user's token (`gh auth token` or a `secrets:own` setting). Never log or commit tokens.
- Request only the capabilities needed; adding capabilities re-prompts users on update.
- Docs: https://github.com/stablyai/orca/blob/main/docs/reference/plugin-authoring.md , https://orca.dev/plugins/add
- To list publicly: public repo, license, `orca-plugin` topic, `vX.Y.Z` tag. `publisher` is derived from the repo owner; don't set it.

## Status
Working: 30s polling with pagination (cap 500), grouping by type/repo with per-group paging, PR author and state lookups, delayed mark-as-done with Undo, mark all read, Orca worktree links and "review in a new worktree", `...` settings menu with a "Last fetched" line, configurable desktop notifications (one switch per kind: review requests, mentions, assignments, comments, CI; they only control pop-ups, not the list). Open links carry GitHub's `notification_referrer_id` (worked out by the worker, see `referrerToken`) and `notifications_query`, so the PR page shows the "Back to notifications / Done" bar. Tests (31), validate, `tsc` and `orca plugin check` pass. `src/node-shim.d.ts` stands in for @types/node.
Known gaps: the desktop notification has not been seen firing against a live new thread; the count can differ from github.com when over the 500 cap; whether Orca renders manifest setting `description`s is unconfirmed. Open, Merged and Closed are custom outlined pills (Draft uses a `Badge`), because badge tones do not match each other and there is no purple.
Next: verify a live notification, publish (public repo, `orca-plugin` topic, `v0.1.0` tag).
