// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

declare module 'orca' {
  interface GhNotification {
    id: string
    /** GitHub's reason: review_requested, mention, assign, author, ci_activity, ... */
    reason: string
    title: string
    /** owner/name */
    repo: string
    /** PullRequest, Issue, Commit, Release, Discussion, CheckSuite, ... */
    type: string
    /** Browser URL for the subject. */
    url: string
    /** Login of the PR or issue author; null until looked up, or for other kinds of thread. */
    author: string | null
    /** State of the PR or issue; null until looked up, or when the lookup is out of date. */
    state: 'open' | 'draft' | 'merged' | 'closed' | null
    /** Token for `?notification_referrer_id=`, which makes GitHub show its "Done / Unsubscribe" bar on the page; null until known. */
    referrer: string | null
    unread: boolean
    updatedAt: string
  }
  interface GhSnapshot {
    items: GhNotification[]
    /** ms epoch of the last successful fetch; 0 before the first. */
    fetchedAt: number
    /** True when GitHub has more unread threads than the worker's page cap loads. */
    truncated: boolean
    /** Threads marked as done that are still waiting to be sent to GitHub, so Undo can bring them back. */
    pending: number
    /** Human-readable problem (no token, rate limit, network); null when fine. */
    error: string | null
  }
  /** What Orca knows about pull requests, from `orca worktree list` and `orca repo list`. */
  interface OrcaLinks {
    /** False when the orca CLI is missing or cannot reach the app. */
    available: boolean
    error: string | null
    /** Lower-cased PR URL -> the worktree linked to it. */
    links: Record<string, { id: string; name: string }>
    /** Lower-cased owner/name of the GitHub repos registered in Orca. */
    repos: string[]
  }
  interface OrcaActionResult {
    ok: boolean
    error: string | null
    /** The worktree acted on or created. */
    worktreeId: string | null
  }
  interface PluginRequests {
    /** Which PRs already have a worktree, and which repos Orca has. */
    'orca.links': { output: OrcaLinks }
    /** Reveals an existing worktree in Orca. */
    'orca.openWorktree': { input: { id: string }; output: OrcaActionResult }
    /** Fetches the PR's head and creates a linked worktree on it, then reveals it. */
    'orca.reviewInWorktree': { input: { url: string }; output: OrcaActionResult }
    /** The last snapshot; starts polling if needed. */
    'notifications.list': { output: GhSnapshot }
    /** Fetches now. */
    'notifications.refresh': { output: GhSnapshot }
    /** Marks one thread done: it leaves the list now and is sent to GitHub after a few quiet seconds. */
    'notifications.markRead': { input: { id: string }; output: GhSnapshot }
    /** Brings back everything marked done that has not been sent yet. */
    'notifications.undo': { output: GhSnapshot }
    /** Marks everything read. */
    'notifications.markAllRead': { output: GhSnapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel when the list changes. */
    'notifications.changed': GhSnapshot
  }
}
