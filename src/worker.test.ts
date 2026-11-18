// Runs src/worker.ts's activate(orca) with the orca object Orca passes, over a mock host.
import { assert, mockHost, mountWorker, test } from 'orca/testing'
import * as main from './worker'

const thread = (id: string, reason: string) => ({
  id,
  reason,
  unread: true,
  updated_at: '2026-11-18T10:00:00Z',
  subject: {
    title: `Thread ${id}`,
    url: `https://api.github.com/repos/acme/app/pulls/${id}`,
    type: 'PullRequest'
  },
  repository: { id: 1428868808, full_name: 'acme/app', html_url: 'https://github.com/acme/app' }
})

function fakeFetch(threads: unknown[], calls: { url: string; method: string }[] = []) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(threads), { status: 200 })
  }
}

test('lists unread notifications with browser urls', async () => {
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = fakeFetch([thread('7', 'review_requested')])
  const worker = await mountWorker(main, { host: mockHost() })
  const snap = await worker.request('notifications.refresh')
  assert.equal(snap.error, null)
  assert.equal(snap.items.length, 1)
  assert.equal(snap.items[0].url, 'https://github.com/acme/app/pull/7')
  await worker.deactivate()
})

test('reports a missing token instead of throwing', async () => {
  main.deps.getToken = async () => null
  const worker = await mountWorker(main, { host: mockHost() })
  const snap = await worker.request('notifications.refresh')
  assert.ok(snap.error?.includes('No GitHub token'))
  await worker.deactivate()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const patches = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method === 'PATCH').map((c) => c.url.split('/').pop())

test('mark as done hides the thread now and sends it to GitHub after the undo window', async () => {
  const calls: { url: string; method: string }[] = []
  main.deps.undoMs = 30
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = fakeFetch([thread('1', 'mention'), thread('2', 'mention')], calls)
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('notifications.refresh')
  const snap = await worker.request('notifications.markRead', { id: '1' })
  assert.deepEqual(
    snap.items.map((i) => i.id),
    ['2']
  )
  assert.equal(snap.pending, 1)
  assert.deepEqual(patches(calls), [], 'nothing sent yet')
  // A poll inside the window must not bring it back.
  const polled = await worker.request('notifications.refresh')
  assert.deepEqual(
    polled.items.map((i) => i.id),
    ['2']
  )
  await sleep(100)
  assert.deepEqual(patches(calls), ['1'])
  const after = await worker.request('notifications.list')
  assert.equal(after.pending, 0)
  await worker.deactivate()
})

test('undo brings queued threads back and nothing is sent', async () => {
  const calls: { url: string; method: string }[] = []
  main.deps.undoMs = 30
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = fakeFetch([thread('1', 'mention'), thread('2', 'mention')], calls)
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('notifications.refresh')
  await worker.request('notifications.markRead', { id: '1' })
  const back = await worker.request('notifications.undo')
  assert.deepEqual(
    back.items.map((i) => i.id).sort(),
    ['1', '2']
  )
  assert.equal(back.pending, 0)
  await sleep(100)
  assert.deepEqual(patches(calls), [])
  await worker.deactivate()
})

test('each mark restarts the wait, and they are sent together', async () => {
  const calls: { url: string; method: string }[] = []
  main.deps.undoMs = 60
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = fakeFetch([thread('1', 'mention'), thread('2', 'mention')], calls)
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('notifications.refresh')
  await worker.request('notifications.markRead', { id: '1' })
  await sleep(40)
  await worker.request('notifications.markRead', { id: '2' })
  await sleep(40)
  assert.deepEqual(patches(calls), [], 'the second mark pushed the send back')
  await sleep(80)
  assert.deepEqual(patches(calls).sort(), ['1', '2'])
  await worker.deactivate()
})

test('a thread GitHub refuses comes back with the error', async () => {
  main.deps.undoMs = 20
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = async (_url: string, init?: RequestInit) =>
    init?.method === 'PATCH'
      ? new Response('', { status: 403, statusText: 'Forbidden' })
      : new Response(JSON.stringify([thread('1', 'mention')]), { status: 200 })
  const worker = await mountWorker(main, { host: mockHost() })
  await worker.request('notifications.refresh')
  await worker.request('notifications.markRead', { id: '1' })
  await sleep(80)
  const snap = await worker.request('notifications.list')
  assert.deepEqual(
    snap.items.map((i) => i.id),
    ['1']
  )
  assert.ok(snap.error?.includes('403'))
  await worker.deactivate()
})

test('follows Link headers across pages and flags the page cap', async () => {
  const urls: string[] = []
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = async (url: string) => {
    urls.push(url)
    const page = Number(new URL(url).searchParams.get('page') ?? '1')
    const next = `<https://api.github.com/notifications?per_page=50&page=${page + 1}>; rel="next"`
    return new Response(JSON.stringify([thread(`p${page}`, 'mention')]), {
      status: 200,
      headers: { link: next }
    })
  }
  const worker = await mountWorker(main, { host: mockHost() })
  const snap = await worker.request('notifications.refresh')
  assert.equal(snap.items.length, 10)
  assert.equal(snap.truncated, true)
  assert.equal(urls.filter((u) => u.includes('/notifications?')).length, 10)
  await worker.deactivate()
})

test('never follows a next link off the GitHub API host', () => {
  assert.equal(main.nextLink('<https://evil.example/x>; rel="next"'), null)
  assert.equal(
    main.nextLink(
      '<https://api.github.com/notifications?page=2>; rel="next", <https://api.github.com/notifications?page=9>; rel="last"'
    ),
    'https://api.github.com/notifications?page=2'
  )
  assert.equal(main.nextLink(null), null)
})

type Call = { file: string; args: string[] }
/** Replaces deps.exec with a script keyed on the first words of the command. */
function fakeExec(answers: Record<string, unknown>, calls: Call[] = []) {
  main.deps.exec = async (file: string, args: readonly string[]) => {
    calls.push({ file, args: [...args] })
    const key = file.endsWith('git') ? 'git' : args.slice(0, 2).join(' ')
    const a = answers[key]
    if (a === undefined) return { ok: false, stdout: '', stderr: `unexpected ${key}`, missing: false }
    if (typeof a === 'string') return { ok: false, stdout: '', stderr: a, missing: false }
    return { ok: true, stdout: JSON.stringify({ ok: true, result: a }), stderr: '', missing: false }
  }
  return calls
}

const REPO = {
  id: 'r1',
  path: '/code/app',
  gitRemoteIdentity: { canonicalKey: 'github.com/Acme/App', remoteName: 'origin' }
}
const PR = 'https://github.com/acme/app/pull/12'

test('loadOrcaLinks maps PR links and registered repos, skipping archived worktrees', async () => {
  fakeExec({
    'worktree list': {
      worktrees: [
        {
          id: 'r1::/wt/a',
          displayName: 'a',
          linkedItems: [{ provider: 'github', type: 'pr', url: 'https://github.com/Acme/App/pull/12' }]
        },
        {
          id: 'r1::/wt/old',
          displayName: 'old',
          isArchived: true,
          linkedItems: [{ provider: 'github', type: 'pr', url: 'https://github.com/acme/app/pull/13' }]
        }
      ]
    },
    'repo list': { repos: [REPO] }
  })
  const l = await main.loadOrcaLinks()
  assert.equal(l.available, true)
  assert.deepEqual(l.links, { [PR]: { id: 'r1::/wt/a', name: 'a' } })
  assert.deepEqual(l.repos, ['acme/app'])
})

test('loadOrcaLinks reports unavailable instead of throwing', async () => {
  fakeExec({})
  const l = await main.loadOrcaLinks()
  assert.equal(l.available, false)
  assert.ok(l.error)
})

test('openWorktree refuses ids that are not worktree ids', async () => {
  const calls = fakeExec({ 'worktree activate': {} })
  const bad = await main.openWorktree('--evil')
  assert.equal(bad.ok, false)
  assert.equal(calls.length, 0)
  const good = await main.openWorktree('r1::/wt/a')
  assert.equal(good.ok, true)
  assert.deepEqual(calls[0].args.slice(0, 4), ['worktree', 'activate', '--worktree', 'id:r1::/wt/a'])
})

test('reviewInWorktree fetches the PR head, then creates a linked worktree', async () => {
  const calls = fakeExec({
    'repo list': { repos: [REPO] },
    git: {},
    'worktree create': { worktree: { id: 'r1::/wt/pr-12' } }
  })
  const r = await main.reviewInWorktree(PR)
  assert.deepEqual(r, { ok: true, error: null, worktreeId: 'r1::/wt/pr-12' })
  const git = calls.find((c) => c.file.endsWith('git'))!
  assert.deepEqual(git.args, ['-C', '/code/app', 'fetch', 'origin', '+refs/pull/12/head:refs/remotes/origin/pr-12'])
  const create = calls.find((c) => c.args[1] === 'create')!
  assert.ok(create.args.join(' ').includes('--base-branch origin/pr-12'))
  assert.ok(create.args.join(' ').includes(`--reference ${PR}`))
})

test('reviewInWorktree rejects bad urls, unknown repos and fetch failures', async () => {
  fakeExec({ 'repo list': { repos: [REPO] }, git: 'fatal: nope' })
  assert.equal((await main.reviewInWorktree('https://evil.com/a/b/pull/1')).ok, false)
  const unknown = await main.reviewInWorktree('https://github.com/other/thing/pull/1')
  assert.ok(unknown.error?.includes('not a repo in Orca'))
  const failed = await main.reviewInWorktree(PR)
  assert.ok(failed.error?.includes('git fetch failed'))
})

// Copied from a link on github.com/notifications (user 26026366, repo 1428868808, issue 6455355881).
const SAMPLE_TOKEN = 'NT_kwHOAY0hftoAJlJlcG9zaXRvcnk7MTQyODg2ODgwODtJc3N1ZTs2NDU1MzU1ODgx'

test('builds the same notification_referrer_id GitHub puts in its own links', () => {
  assert.equal(main.referrerToken(26026366, 1428868808, 6455355881), SAMPLE_TOKEN)
})

test('looks up PR authors after the list, once, and keeps them', async () => {
  const urls: string[] = []
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = async (url: string) => {
    urls.push(url)
    if (url.endsWith('/user')) return new Response(JSON.stringify({ id: 26026366 }))
    if (url.includes('/issues/')) {
      return new Response(
        JSON.stringify({
          id: 6455355881,
          user: { login: 'octocat' },
          state: 'closed',
          pull_request: { merged_at: '2026-11-18T09:00:00Z' }
        })
      )
    }
    return new Response(JSON.stringify([thread('7', 'review_requested')]))
  }
  const host = mockHost()
  const worker = await mountWorker(main, { host })
  await worker.request('notifications.refresh')
  await new Promise((r) => setTimeout(r, 20))
  const snap = await worker.request('notifications.list')
  assert.equal(snap.items[0].author, 'octocat')
  assert.equal(snap.items[0].state, 'merged')
  assert.equal(snap.items[0].referrer, SAMPLE_TOKEN, 'the notification_referrer_id is built from ids')
  await worker.request('notifications.refresh')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(urls.filter((u) => u.includes('/issues/')).length, 1, 'cached after the first lookup')
  await worker.deactivate()
})

test('desktop notifications follow the notification settings', async () => {
  const threads = [thread('1', 'mention')]
  main.deps.getToken = async () => 'tok'
  main.deps.fetch = async () => new Response(JSON.stringify(threads), { status: 200 })
  const host = mockHost({ settings: { notifyMentions: false, notifyComments: true } })
  const worker = await mountWorker(main, { host })
  await worker.request('notifications.refresh')
  // The first poll only records. Now a mention (switched off), a comment (on) and CI (default off) arrive.
  threads.push(thread('2', 'mention'), thread('3', 'comment'), thread('4', 'ci_activity'))
  await worker.request('notifications.refresh')
  const shown = host.callsOf('notifications.show') as { title: string }[]
  assert.deepEqual(
    shown.map((c) => c.title),
    ['New comment: acme/app']
  )
  await worker.deactivate()
})
