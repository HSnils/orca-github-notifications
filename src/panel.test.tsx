// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'

const snap = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({
    id: String(i),
    reason: i === 0 ? 'review_requested' : 'mention',
    title: `Thread ${i}`,
    repo: 'acme/app',
    type: 'PullRequest',
    author: i === 0 ? 'octocat' : null,
    state: i === 0 ? ('merged' as const) : null,
    referrer: i === 0 ? 'NT_abc' : null,
    url: `https://github.com/acme/app/pull/${i}`,
    unread: true,
    updatedAt: '2026-11-18T10:00:00Z'
  })),
  fetchedAt: 1,
  truncated: false,
  error: null,
  pending: 0
})

/** What the worker answers when no PR has a worktree and Orca has no repos. */
const noOrca = { available: true, error: null, links: {}, repos: [] as string[] }

test('shows the unread count and reacts to worker posts', async () => {
  const host = mockHost({
    requests: { 'notifications.list': () => snap(2), 'orca.links': () => noOrca }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ role: 'status' })?.text, '2')

  await view.post('notifications.changed', snap(3))
  assert.equal(view.find({ role: 'status' })?.text, '3')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('groups by reason with review requests first, and by repo on demand', async () => {
  const items = snap(3).items
  const byReason = panel.groupItems(items, 'reason')
  assert.deepEqual(
    byReason.map((g) => [g.title, g.items.length]),
    [
      ['Review requested', 1],
      ['Mentions', 2]
    ]
  )
  items[1].repo = 'acme/other'
  const byRepo = panel.groupItems(items, 'repo')
  assert.deepEqual(
    byRepo.map((g) => [g.title, g.items.length]),
    [
      ['acme/app', 2],
      ['acme/other', 1]
    ]
  )
})

test('shows a + when the worker hit its page cap', async () => {
  const host = mockHost({
    requests: {
      'notifications.list': () => ({ ...snap(2), truncated: true }),
      'orca.links': () => noOrca
    }
  })
  const view = await mount(panel, { host })
  assert.equal(view.find({ role: 'status' })?.text, '2+')
  await view.unmount()
})

test('marking everything read needs a second, confirming press', async () => {
  let marked = 0
  const host = mockHost({
    requests: {
      'notifications.list': () => snap(2),
      'orca.links': () => noOrca,
      'notifications.markAllRead': () => {
        marked++
        return snap(0)
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Settings' })
  await view.press({ text: 'Mark all read…' })
  assert.equal(marked, 0)
  await view.press({ text: 'Mark all read' })
  assert.equal(marked, 1)
  assert.equal(view.find({ role: 'status' })?.text, '0')
  await view.unmount()
})

const PR0 = 'https://github.com/acme/app/pull/0'

test('a PR with a worktree shows it and goes to it', async () => {
  const opened: string[] = []
  const host = mockHost({
    requests: {
      'notifications.list': () => snap(1),
      'orca.links': () => ({
        available: true,
        error: null,
        // Orca records URLs in its own case; the panel matches case-insensitively.
        links: { [PR0.toLowerCase()]: { id: 'repo::/wt/my-wt', name: 'my-wt' } },
        repos: ['acme/app']
      }),
      'orca.openWorktree': ({ id }) => {
        opened.push(id)
        return { ok: true, error: null, worktreeId: id }
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'my-wt' }), 'shows the worktree name')
  assert.ok(view.find({ text: /@octocat/ }), 'shows the PR author')
  assert.ok(view.find({ text: 'Merged' }), 'shows the PR state')
  assert.ok(!view.find({ label: /Review .* in a new worktree/ }))
  await view.press({ label: /Go to worktree/ })
  assert.deepEqual(opened, ['repo::/wt/my-wt'])
  await view.unmount()
})

test('a PR without a worktree can be reviewed in a new one, once Orca has the repo', async () => {
  const reviewed: string[] = []
  const links = { available: true, error: null, links: {}, repos: ['acme/app'] }
  const host = mockHost({
    requests: {
      'notifications.list': () => snap(1),
      'orca.links': () =>
        reviewed.length
          ? { ...links, links: { [PR0]: { id: 'repo::/wt/pr-0', name: 'pr-0' } } }
          : links,
      'orca.reviewInWorktree': ({ url }) => {
        reviewed.push(url)
        return { ok: true, error: null, worktreeId: 'repo::/wt/pr-0' }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: /Review .* in a new worktree/ })
  assert.deepEqual(reviewed, [PR0])
  // The links are reloaded after the action, so the new worktree shows up.
  assert.ok(view.find({ text: 'pr-0' }))
  await view.unmount()
})

test('no worktree button for a repo Orca does not have, and failures are shown', async () => {
  const host = mockHost({
    requests: {
      'notifications.list': () => snap(1),
      'orca.links': () => ({ ...noOrca, repos: ['other/repo'] })
    }
  })
  const view = await mount(panel, { host })
  assert.ok(!view.find({ label: /Review .* in a new worktree/ }))
  await view.unmount()

  const failing = mockHost({
    requests: {
      'notifications.list': () => snap(1),
      'orca.links': () => ({ ...noOrca, repos: ['acme/app'] }),
      'orca.reviewInWorktree': () => ({ ok: false, error: 'git fetch failed: nope', worktreeId: null })
    }
  })
  const view2 = await mount(panel, { host: failing })
  await view2.press({ label: /Review .* in a new worktree/ })
  assert.ok(view2.find({ text: /git fetch failed: nope/ }))
  await view2.unmount()
})

test('GitHub errors and failed refreshes show in a box at the top; the spinner stops after', async () => {
  let fail = false
  const host = mockHost({
    requests: {
      'notifications.list': () => ({ ...snap(1), error: 'GitHub answered 401 Unauthorized' }),
      'orca.links': () => noOrca,
      'notifications.refresh': () => {
        if (fail) throw new Error('worker went away')
        return snap(1)
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: /401 Unauthorized/ }), 'snapshot error is shown')

  await view.press({ label: 'Settings' })
  await view.press({ text: 'Refresh' })
  assert.ok(!view.find({ text: /401 Unauthorized/ }), 'a good refresh clears it')
  assert.ok(!view.find({ label: 'Refreshing' }), 'spinner is gone once refreshed')

  fail = true
  await view.press({ text: 'Refresh' })
  assert.ok(view.find({ text: /worker went away/ }), 'a failed call is shown')
  assert.ok(!view.find({ label: 'Refreshing' }), 'spinner is gone after a failure too')
  await view.unmount()
})

test('a big group draws a page of rows and reveals more on request', async () => {
  const host = mockHost({
    requests: {
      'notifications.list': () => ({
        ...snap(60),
        items: snap(60).items.map((i) => ({ ...i, reason: 'mention' }))
      }),
      'orca.links': () => noOrca
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: 'Thread 24' }))
  assert.ok(!view.find({ text: 'Thread 25' }), 'only the first page is drawn')
  await view.press({ text: /Show 25 more \(35 hidden\)/ })
  assert.ok(view.find({ text: 'Thread 49' }))
  assert.ok(!view.find({ text: 'Thread 50' }))
  await view.unmount()
})

test('Undo shows while threads are queued as done, and asks the worker to bring them back', async () => {
  let undone = 0
  const host = mockHost({
    requests: {
      'notifications.list': () => ({ ...snap(1), pending: 2 }),
      'orca.links': () => noOrca,
      'notifications.undo': () => {
        undone++
        return snap(3)
      }
    }
  })
  const view = await mount(panel, { host })
  assert.ok(view.find({ text: '2 marked as done' }))
  await view.press({ text: 'Undo' })
  assert.equal(undone, 1)
  assert.ok(!view.find({ text: 'Undo' }), 'the bar goes away once nothing is queued')
  assert.equal(view.find({ role: 'status' })?.text, '3')
  await view.unmount()
})

test('the Show and Group by radios mark the current mode and change the list', async () => {
  const host = mockHost({
    requests: { 'notifications.list': () => snap(3), 'orca.links': () => noOrca }
  })
  const view = await mount(panel, { host })
  // snap(3): one review request and two mentions.
  assert.equal(view.find({ role: 'status' })?.text, '3')
  assert.ok(!view.find({ label: 'Show' }), 'the settings are closed at first')
  await view.press({ label: 'Settings' })
  await view.select({ label: 'Show' }, 'reviews')
  assert.equal(view.find({ role: 'status' })?.text, '1')
  assert.ok(view.find({ text: 'Reviews only' }), 'a filtered list says so in the header')
  await view.select({ label: 'Show' }, 'all')
  assert.equal(view.find({ role: 'status' })?.text, '3')

  assert.ok(view.find({ text: /Mentions \(2\)/ }))
  await view.select({ label: 'Group by' }, 'repo')
  assert.ok(view.find({ text: /acme\/app \(3\)/ }))
  await view.unmount()
})

test('the open button opens the thread on GitHub', async () => {
  const host = mockHost({
    requests: { 'notifications.list': () => snap(1), 'orca.links': () => noOrca }
  })
  const view = await mount(panel, { host })
  await view.press({ label: /Open .* on GitHub/ })
  assert.deepEqual(host.callsOf('shell.openExternal'), [
    { url: `${PR0}?notification_referrer_id=NT_abc` }
  ])
  await view.unmount()
})

test('marking threads done removes them at once and only the last answer wins', async () => {
  const asked: string[] = []
  const host = mockHost({
    requests: {
      'notifications.list': () => snap(3),
      'orca.links': () => noOrca,
      'notifications.markRead': ({ id }) => {
        asked.push(id)
        return { ...snap(3), items: snap(3).items.filter((i) => !asked.includes(i.id)), pending: asked.length }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ label: 'Mark Thread 1 as done' })
  await view.press({ label: 'Mark Thread 2 as done' })
  assert.deepEqual(asked, ['1', '2'])
  assert.equal(view.find({ role: 'status' })?.text, '1')
  assert.ok(view.find({ text: '2 marked as done' }))
  await view.unmount()
})

test('the settings menu says when the list was last fetched', async () => {
  const host = mockHost({
    requests: { 'notifications.list': () => snap(1), 'orca.links': () => noOrca }
  })
  const view = await mount(panel, { host })
  assert.ok(!view.find({ text: /Last fetched/ }), 'only inside the menu')
  await view.press({ label: 'Settings' })
  assert.ok(view.find({ text: /Last fetched/ }))
  await view.unmount()
})
