// Polls GitHub's notifications API and answers the panel. State that must survive a worker
// reload (ids already notified about) lives in orca.storage.
import type { GhNotification, GhSnapshot, OrcaActionResult, OrcaLinks } from 'orca'
import type { OrcaWorkerApi } from 'orca/worker'
import { execFile } from 'node:child_process'

const API = 'https://api.github.com'
const SEEN = 'seenIds'
/** Manifest setting -> the GitHub reasons it switches on. */
const NOTIFY_SETTINGS: Record<string, string[]> = {
  notifyReviewRequests: ['review_requested'],
  notifyMentions: ['mention', 'team_mention'],
  notifyAssignments: ['assign'],
  notifyComments: ['comment'],
  notifyCi: ['ci_activity']
}
const NOTIFY_DEFAULTS: Record<string, boolean> = {
  notifyReviewRequests: true,
  notifyMentions: true,
  notifyAssignments: false,
  notifyComments: false,
  notifyCi: false
}
const NOTIFY_TITLES: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  team_mention: 'Team mentioned',
  assign: 'Assigned',
  comment: 'New comment',
  ci_activity: 'CI activity'
}
const META = 'threadMeta'
/** Author lookups per poll, and how many run at once. */
const AUTHORS_PER_POLL = 40
const AUTHOR_CONCURRENCY = 4
const PER_PAGE = 50
/** 10 pages of 50: more than anyone reads, and it bounds the requests per poll. */
const MAX_PAGES = 10

/** The `rel="next"` URL from a Link header. Ignores any host but GitHub's API, so the token
 *  is never sent anywhere else. */
export function nextLink(link: string | null): string | null {
  const m = link?.match(/<([^>]+)>\s*;\s*rel="next"/)
  return m && m[1].startsWith(`${API}/`) ? m[1] : null
}

/** Swapped out by tests. */
export const deps = {
  fetch: (url: string, init?: RequestInit): Promise<Response> => fetch(url, init),
  getToken: (): Promise<string | null> =>
    new Promise((resolve) => {
      const env = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
      if (env) return resolve(env)
      execFile('gh', ['auth', 'token'], { timeout: 5000 }, (err, out) =>
        resolve(err ? null : out.trim() || null)
      )
    }),
  /** Runs a program without a shell. `missing` is true when the binary does not exist. */
  exec: (
    file: string,
    args: string[],
    timeoutMs = 30_000
  ): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> =>
    new Promise((resolve) => {
      execFile(
        file,
        args,
        { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout, stderr) =>
          resolve({
            ok: !err,
            stdout,
            stderr: err ? stderr || err.message : stderr,
            missing: !!err && (err as { code?: unknown }).code === 'ENOENT'
          })
      )
    }),
  pollMs: 30_000,
  /** How long marked-as-done threads wait, undoable, before they are sent to GitHub. */
  undoMs: 5_000
}

// The worker's PATH is filtered, so fall back to where the macOS app and Apple's git live.
const ORCA_BINS = ['orca', '/Applications/Orca.app/Contents/Resources/bin/orca']
const GIT_BINS = ['git', '/usr/bin/git']

/** First binary that exists wins; a binary that exists but fails is a real failure. */
async function run(bins: string[], args: string[], timeoutMs?: number) {
  for (const bin of bins) {
    const r = await deps.exec(bin, args, timeoutMs)
    if (!r.missing) return r
  }
  return { ok: false, stdout: '', stderr: `${bins[0]} was not found`, missing: true }
}

const oneLine = (s: string): string => s.trim().split('\n')[0]?.slice(0, 300) || 'failed'

/** `orca <args> --json`, unwrapped to its `result`. Throws with a readable message. */
async function orcaJson(args: string[], timeoutMs?: number): Promise<Record<string, any>> {
  const r = await run(ORCA_BINS, [...args, '--json'], timeoutMs)
  if (!r.ok) throw new Error(oneLine(r.stderr || r.stdout))
  let d: any
  try {
    d = JSON.parse(r.stdout)
  } catch {
    throw new Error('orca answered with something that is not JSON')
  }
  if (d?.ok === false) throw new Error(oneLine(JSON.stringify(d.error ?? d)))
  return d?.result ?? d
}

type OrcaRepo = {
  id: string
  path: string
  gitRemoteIdentity?: { canonicalKey?: string; remoteName?: string } | null
}

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/
const SAFE_NAME = /^[\w.-]+$/

const repoSlug = (r: OrcaRepo): string | null => {
  const key = r.gitRemoteIdentity?.canonicalKey?.toLowerCase()
  return key?.startsWith('github.com/') ? key.slice('github.com/'.length) : null
}

export async function loadOrcaLinks(): Promise<OrcaLinks> {
  try {
    const [wt, rp] = await Promise.all([orcaJson(['worktree', 'list']), orcaJson(['repo', 'list'])])
    const links: OrcaLinks['links'] = {}
    for (const w of (wt.worktrees ?? []) as any[]) {
      if (w.isArchived) continue
      for (const item of (w.linkedItems ?? []) as any[]) {
        if (item?.provider === 'github' && item.type === 'pr' && typeof item.url === 'string') {
          links[item.url.toLowerCase()] ??= { id: w.id, name: w.displayName }
        }
      }
    }
    const repos = ((rp.repos ?? []) as OrcaRepo[]).map(repoSlug).filter((s): s is string => !!s)
    return { available: true, error: null, links, repos }
  } catch (e) {
    return { available: false, error: String((e as Error).message ?? e), links: {}, repos: [] }
  }
}

const fail = (error: string): OrcaActionResult => ({ ok: false, error, worktreeId: null })

export async function openWorktree(id: string): Promise<OrcaActionResult> {
  // Worktree ids are `<repo id>::<absolute path>`; refuse anything else.
  if (!/^[\w-]+::\/.+$/.test(id)) return fail('Not a worktree id')
  try {
    await orcaJson(['worktree', 'activate', '--worktree', `id:${id}`])
    return { ok: true, error: null, worktreeId: id }
  } catch (e) {
    return fail(String((e as Error).message ?? e))
  }
}

/** Fetches the PR's head (forks included: GitHub serves it at refs/pull/N/head) and creates a
 *  worktree on it, linked to the PR. `--reference` only links; it does not check anything out. */
export async function reviewInWorktree(url: string): Promise<OrcaActionResult> {
  const m = PR_URL.exec(url)
  if (!m) return fail('Not a GitHub pull request URL')
  const [, owner, name, num] = m
  try {
    const rp = await orcaJson(['repo', 'list'])
    const repo = ((rp.repos ?? []) as OrcaRepo[]).find(
      (r) => repoSlug(r) === `${owner}/${name}`.toLowerCase()
    )
    if (!repo) return fail(`${owner}/${name} is not a repo in Orca`)
    const remote = repo.gitRemoteIdentity?.remoteName ?? 'origin'
    if (!SAFE_NAME.test(remote)) return fail('Unexpected remote name')

    const ref = `${remote}/pr-${num}`
    const fetched = await run(
      GIT_BINS,
      ['-C', repo.path, 'fetch', remote, `+refs/pull/${num}/head:refs/remotes/${ref}`],
      120_000
    )
    if (!fetched.ok) return fail(`git fetch failed: ${oneLine(fetched.stderr)}`)

    const created = await orcaJson(
      [
        'worktree', 'create',
        '--repo', `id:${repo.id}`,
        '--name', `pr-${num}`,
        '--base-branch', ref,
        '--reference', url,
        '--activate'
      ],
      120_000
    )
    const id = (created.worktree?.id ?? created.id ?? null) as string | null
    return { ok: true, error: null, worktreeId: id }
  } catch (e) {
    return fail(String((e as Error).message ?? e))
  }
}

type ApiThread = {
  id: string
  reason: string
  unread: boolean
  updated_at: string
  subject: { title: string; url: string | null; type: string }
  repository: { full_name: string; html_url: string }
}

/** API subject URL -> browser URL; falls back to the repo page. */
export function htmlUrl(t: ApiThread): string {
  const repo = t.repository.html_url
  const m = t.subject.url?.match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/(.+)$/)
  if (!m) return t.subject.type === 'Discussion' ? `${repo}/discussions` : repo
  const [, slug, kind, rest] = m
  const base = `https://github.com/${slug}`
  if (kind === 'pulls') return `${base}/pull/${rest}`
  if (kind === 'commits') return `${base}/commit/${rest}`
  if (kind === 'releases') return `${base}/releases`
  return `${base}/issues/${rest}`
}

function toItem(t: ApiThread): GhNotification {
  return {
    id: t.id,
    reason: t.reason,
    title: t.subject.title,
    repo: t.repository.full_name,
    type: t.subject.type,
    url: htmlUrl(t),
    author: null,
    state: null,
    unread: t.unread,
    updatedAt: t.updated_at
  }
}

let stopCurrent: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  let snapshot: GhSnapshot = { items: [], fetchedAt: 0, truncated: false, error: null, pending: 0 }
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastModified: string | null = null
  let stopped = false
  let started = false
  let inflight: Promise<GhSnapshot> | null = null
  /** Thread id -> what the PR or issue looked like at `at` (the thread's updatedAt). */
  type Meta = { author: string | null; state: GhNotification['state']; at: string }
  let metas: Record<string, Meta> | null = null
  /** Thread id -> API url of its PR or issue, for looking the author up. */
  const subjectUrls = new Map<string, string>()
  let enriching = false

  /** Threads marked as done but not yet sent to GitHub (Undo applies), and ones being sent. */
  const pending = new Map<string, GhNotification>()
  const sending = new Map<string, GhNotification>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  // `pending` is always filled in here, from the queue.
  const publish = (next: Omit<GhSnapshot, 'pending'> & { pending?: number }): GhSnapshot => {
    snapshot = { ...next, pending: pending.size }
    orca.panels.post('notifications.changed', snapshot)
    return snapshot
  }

  async function headers(): Promise<Record<string, string> | null> {
    const token = await deps.getToken()
    if (!token) return null
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  }

  /** The reasons the person wants a desktop notification for (declared in the manifest's
   *  settings, so they are changed in Orca's Settings). Defaults apply if they cannot be read. */
  async function notifyingReasons(): Promise<Set<string>> {
    let values: Record<string, unknown> = {}
    try {
      values = await orca.settings.get()
    } catch {
      // Use the defaults.
    }
    const reasons = new Set<string>()
    for (const [key, list] of Object.entries(NOTIFY_SETTINGS)) {
      if ((values[key] ?? NOTIFY_DEFAULTS[key]) === true) for (const r of list) reasons.add(r)
    }
    return reasons
  }

  async function notifyNew(items: GhNotification[]): Promise<void> {
    const stored = await orca.storage.get(SEEN)
    const first = !Array.isArray(stored)
    const seen = new Set<string>(Array.isArray(stored) ? (stored as string[]) : [])
    const key = (i: GhNotification): string => `${i.id}@${i.updatedAt}`
    const fresh = items.filter((i) => !seen.has(key(i)))
    // Keep the stored set bounded to what is currently listed.
    await orca.storage.set(SEEN, items.map(key))
    // The first run only records; it would otherwise announce the whole backlog.
    if (first) return
    const wanted = await notifyingReasons()
    for (const i of fresh.filter((n) => wanted.has(n.reason))) {
      try {
        await orca.host.call('notifications.show', {
          title: `${NOTIFY_TITLES[i.reason] ?? 'GitHub'}: ${i.repo}`,
          body: i.title
        })
      } catch (e) {
        orca.log(`notification failed: ${String(e)}`)
      }
    }
  }

  async function doFetch(): Promise<GhSnapshot> {
    const h = await headers()
    if (!h) {
      return publish({ ...snapshot, error: 'No GitHub token. Run `gh auth login` or set GH_TOKEN.' })
    }
    try {
      const threads: ApiThread[] = []
      let url: string | null = `${API}/notifications?per_page=${PER_PAGE}`
      let truncated = false
      for (let page = 1; url; page++) {
        const res: Response = await deps.fetch(url, {
          // Only the first page can answer "not modified" for the whole list.
          headers: page === 1 && lastModified ? { ...h, 'If-Modified-Since': lastModified } : h
        })
        if (res.status === 304) return publish({ ...snapshot, error: null, fetchedAt: Date.now() })
        if (!res.ok) {
          return publish({ ...snapshot, error: `GitHub answered ${res.status} ${res.statusText}` })
        }
        if (page === 1) lastModified = res.headers.get('last-modified')
        threads.push(...((await res.json()) as ApiThread[]))
        url = nextLink(res.headers.get('link'))
        if (url && page >= MAX_PAGES) {
          truncated = true
          break
        }
      }
      if (!metas) {
        const stored = await orca.storage.get(META)
        metas = stored && typeof stored === 'object' ? (stored as Record<string, Meta>) : {}
      }
      subjectUrls.clear()
      for (const t of threads) {
        if (t.subject.url?.startsWith(`${API}/`) && /\/(pulls|issues)\/\d+$/.test(t.subject.url)) {
          subjectUrls.set(t.id, t.subject.url)
        }
      }
      // Threads marked as done must not reappear while they wait to be sent.
      const items = threads
        .map(toItem)
        .map(withMeta)
        .filter((i) => !pending.has(i.id) && !sending.has(i.id))
      await notifyNew(items)
      return publish({ items, fetchedAt: Date.now(), error: null, truncated })
    } catch (e) {
      return publish({ ...snapshot, error: `Could not reach GitHub: ${String(e)}` })
    }
  }

  /** Adds what has been looked up; an older lookup still gives the author, only the state is stale. */
  const withMeta = (i: GhNotification): GhNotification => {
    const m = metas?.[i.id]
    return m ? { ...i, author: m.author, state: m.at === i.updatedAt ? m.state : null } : i
  }

  /** Looks up missing authors a few at a time (review requests first), then republishes. Spread
   *  over polls so a big inbox does not burn the rate limit in one go. */
  async function enrich(): Promise<void> {
    if (enriching || stopped || !metas) return
    enriching = true
    try {
      const h = await headers()
      if (!h) return
      const todo = snapshot.items
        // A thread is looked up again when it has updated since, as its state may have changed.
        .filter((i) => subjectUrls.has(i.id) && metas?.[i.id]?.at !== i.updatedAt)
        .sort((a, b) => Number(b.reason === 'review_requested') - Number(a.reason === 'review_requested'))
        .slice(0, AUTHORS_PER_POLL)
      let found = false
      const queue = [...todo]
      const worker = async (): Promise<void> => {
        for (let i = queue.shift(); i; i = queue.shift()) {
          try {
            const res: Response = await deps.fetch(subjectUrls.get(i.id)!, { headers: h })
            if (!res.ok) continue
            const d = (await res.json()) as {
              user?: { login?: string }
              state?: string
              merged?: boolean
              merged_at?: string | null
              draft?: boolean
            }
            if (metas) {
              metas[i.id] = {
                author: d.user?.login ?? null,
                state: d.merged || d.merged_at ? 'merged' : d.state === 'closed' ? 'closed' : d.draft ? 'draft' : 'open',
                at: i.updatedAt
              }
              found = true
            }
          } catch {
            // Try again on a later poll.
          }
        }
      }
      await Promise.all(Array.from({ length: AUTHOR_CONCURRENCY }, worker))
      if (!found || stopped || !metas) return
      const live = new Set(snapshot.items.map((i) => i.id))
      for (const id of Object.keys(metas)) if (!live.has(id)) delete metas[id]
      await orca.storage.set(META, metas)
      publish({ ...snapshot, items: snapshot.items.map(withMeta) })
    } finally {
      enriching = false
    }
  }

  const refresh = (): Promise<GhSnapshot> =>
    (inflight ??= doFetch()
      .then((s) => {
        void enrich()
        return s
      })
      .finally(() => {
        inflight = null
      }))

  function schedule(): void {
    if (stopped) return
    timer = setTimeout(async () => {
      await refresh()
      schedule()
    }, deps.pollMs)
  }

  function start(): void {
    if (started) return
    started = true
    void refresh().then(schedule)
  }

  const byNewest = (a: GhNotification, b: GhNotification): number => b.updatedAt.localeCompare(a.updatedAt)

  /** Marks one thread read on GitHub; returns a message on failure. */
  async function sendRead(h: Record<string, string>, id: string): Promise<string | null> {
    try {
      const res = await deps.fetch(`${API}/notifications/threads/${id}`, { method: 'PATCH', headers: h })
      return res.ok ? null : `Mark read failed: ${res.status}`
    } catch (e) {
      return `Could not reach GitHub: ${String(e)}`
    }
  }

  /** "Mark as done" only queues the thread: it leaves the list now and goes to GitHub once the
   *  queue has been quiet for `undoMs`, so a slip can be undone. GitHub cannot mark a thread
   *  unread again, which is why undoing has to happen before sending. */
  function queueRead(id: string): GhSnapshot {
    const item = snapshot.items.find((i) => i.id === id)
    if (!item) return snapshot
    pending.set(id, item)
    // Every addition restarts the wait, so several can be marked in a row.
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = setTimeout(() => void flush(), deps.undoMs)
    return publish({ ...snapshot, items: snapshot.items.filter((i) => i.id !== id) })
  }

  function undoQueued(): GhSnapshot {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    const back = [...pending.values()]
    pending.clear()
    return publish({ ...snapshot, items: [...snapshot.items, ...back].sort(byNewest) })
  }

  async function flush(): Promise<void> {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    if (pending.size === 0) return
    // Moved out of `pending` so Undo no longer applies, but still hidden from polls until sent.
    const batch = [...pending.values()]
    for (const i of batch) sending.set(i.id, i)
    pending.clear()
    publish(snapshot)
    const h = await headers()
    const failed: GhNotification[] = []
    let error: string | null = h ? null : 'No GitHub token.'
    for (const i of batch) {
      const problem = h ? await sendRead(h, i.id) : error
      if (problem) {
        error = problem
        failed.push(i)
      }
      sending.delete(i.id)
    }
    // Threads GitHub did not accept come back, with the reason shown.
    publish({
      ...snapshot,
      error: error ?? snapshot.error,
      items: failed.length ? [...snapshot.items, ...failed].sort(byNewest) : snapshot.items
    })
  }

  async function markAllRead(): Promise<GhSnapshot> {
    if (flushTimer) clearTimeout(flushTimer)
    flushTimer = null
    const h = await headers()
    if (!h) return publish({ ...snapshot, error: 'No GitHub token.' })
    try {
      const res = await deps.fetch(`${API}/notifications`, {
        method: 'PUT',
        headers: h,
        body: JSON.stringify({ read: true })
      })
      if (!res.ok) return publish({ ...snapshot, error: `Mark read failed: ${res.status}` })
    } catch (e) {
      return publish({ ...snapshot, error: `Could not reach GitHub: ${String(e)}` })
    }
    // Everything is read now, queued threads included; this also clears threads past the page cap.
    pending.clear()
    return publish({ ...snapshot, error: null, truncated: false, items: [] })
  }

  orca.panels.handle('notifications.list', async () => {
    start()
    // Before the first fetch finishes the snapshot is empty, which would read as "nothing unread".
    if (snapshot.fetchedAt === 0 && inflight) await inflight
    return snapshot
  })
  orca.panels.handle('notifications.refresh', async () => {
    start()
    return refresh()
  })
  orca.panels.handle('notifications.markRead', async ({ id }) => queueRead(id))
  orca.panels.handle('notifications.undo', async () => undoQueued())
  orca.panels.handle('notifications.markAllRead', () => markAllRead())
  orca.panels.handle('orca.links', () => loadOrcaLinks())
  orca.panels.handle('orca.openWorktree', ({ id }) => openWorktree(id))
  orca.panels.handle('orca.reviewInWorktree', ({ url }) => reviewInWorktree(url))

  // Review-request notifications should fire even with no panel open.
  start()
  orca.log('github-notifications worker started')

  stopCurrent = () => {
    stopped = true
    if (timer) clearTimeout(timer)
    // A reload must not lose what was marked; send it now instead of waiting out the undo window.
    void flush()
  }
}

export function deactivate(): void {
  stopCurrent?.()
}
