// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Collapsible,
  Heading,
  host,
  IconButton,
  plugin,
  read,
  Callout,
  Card,
  RadioGroup,
  RelativeTime,
  Row,
  Separator,
  set,
  Spinner,
  Stack,
  Text,
  update,
  type GhNotification,
  type GhSnapshot,
  type OrcaActionResult,
  type OrcaLinks,
  type PanelContext
} from 'orca'

/** What the worker last reported; null until it answers. */
const snapshot = atom<GhSnapshot | null>(null)
/** Show only review requests. Kept across panel runs. */
const onlyReviews = atom('onlyReviews', false, { persist: 'plugin' })
/** How the list is grouped. Kept across panel runs. */
const groupBy = atom<'reason' | 'repo'>('groupBy', 'repo', { persist: 'plugin' })
/** True after the first press of "Mark all read", until it is confirmed or cancelled. */
const confirmingAll = atom(false)
/** Which PRs already have an Orca worktree; null until the worker answers. */
const orcaLinks = atom<OrcaLinks | null>(null)
/** URLs of PRs whose worktree is being opened or created. */
const busy = atom<string[]>([])
/** Whether the settings card under the header is open. Not kept: it starts closed. */
const menuOpen = atom(false)
/** True while a manual refresh is in flight. */
const refreshing = atom(false)
/** The last panel -> worker call that failed outright (not a GitHub error in a snapshot). */
const requestError = atom<string | null>(null)
/** The last failed worktree action, shown above the list. */
const actionError = atom<string | null>(null)
/** Rows drawn per group. Orca refuses a panel of more than 5000 elements, and a row is about a
 *  dozen, so a large inbox is shown a page at a time. */
const PAGE = 25
/** How many rows each group shows so far, by group key. */
const shownCounts = atom<Record<string, number>>({})

/** Only draft uses the built-in badge. Open, merged and closed are drawn as a pill that copies the
 *  Open badge (hairline outline, coloured dot) with muted text, since badge tones that look
 *  alike do not exist and Orca's Image component is not available in every version. */
const STATES = {
  open: { label: 'Open', tone: null },
  draft: { label: 'Draft', tone: 'neutral' },
  merged: { label: 'Merged', tone: null },
  closed: { label: 'Closed', tone: null }
} as const

const REASONS: Record<string, string> = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  team_mention: 'Team mentioned',
  assign: 'Assigned',
  author: 'Your thread',
  comment: 'Comment',
  ci_activity: 'CI',
  state_change: 'State change'
}

/** Reason groups in the order shown; the first three start open. */
const REASON_GROUPS: { title: string; reasons: string[]; open: boolean }[] = [
  { title: 'Review requested', reasons: ['review_requested'], open: true },
  { title: 'Mentions', reasons: ['mention', 'team_mention'], open: true },
  { title: 'Assigned', reasons: ['assign'], open: true },
  { title: 'Comments', reasons: ['comment'], open: false },
  { title: 'Your threads', reasons: ['author'], open: false },
  { title: 'State changes', reasons: ['state_change'], open: false },
  { title: 'CI', reasons: ['ci_activity'], open: false }
]

type Group = { key: string; title: string; open: boolean; items: GhNotification[] }

export function groupItems(items: GhNotification[], by: 'reason' | 'repo'): Group[] {
  if (by === 'repo') {
    const repos = new Map<string, GhNotification[]>()
    for (const i of items) repos.set(i.repo, [...(repos.get(i.repo) ?? []), i])
    return [...repos.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([repo, list]) => ({ key: repo, title: repo, open: true, items: list }))
  }
  const known = new Set(REASON_GROUPS.flatMap((g) => g.reasons))
  const groups: Group[] = REASON_GROUPS.map((g) => ({
    key: g.title,
    title: g.title,
    open: g.open,
    items: items.filter((i) => g.reasons.includes(i.reason))
  }))
  groups.push({
    key: 'Other',
    title: 'Other',
    open: false,
    items: items.filter((i) => !known.has(i.reason))
  })
  return groups.filter((g) => g.items.length > 0)
}

/** Runs a worker call that answers with a fresh snapshot; a failed call becomes `requestError`. */
async function run(call: () => Promise<GhSnapshot>): Promise<void> {
  set(requestError, null)
  try {
    set(snapshot, await call())
  } catch (e) {
    set(requestError, String((e as Error).message ?? e))
  }
}

let doneSeq = 0
/** Marks a thread done. The row leaves the list at once, without waiting for the worker, so
 *  clicking through many rows stays instant; the worker's answer then replaces the list, but
 *  only the answer to the latest click, so a slow earlier one cannot bring a row back. */
async function markDone(id: string): Promise<void> {
  const mine = ++doneSeq
  set(requestError, null)
  update(snapshot, (s) =>
    s ? { ...s, items: s.items.filter((i) => i.id !== id), pending: s.pending + 1 } : s
  )
  try {
    const next = await plugin.request('notifications.markRead', { id })
    if (mine === doneSeq) set(snapshot, next)
  } catch (e) {
    set(requestError, String((e as Error).message ?? e))
    await run(() => plugin.request('notifications.list'))
  }
}

/** Like `run`, with the spinner on while the worker talks to GitHub. */
async function refresh(): Promise<void> {
  set(refreshing, true)
  try {
    await run(() => plugin.request('notifications.refresh'))
  } finally {
    set(refreshing, false)
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(
    plugin.on('notifications.changed', (payload) => {
      set(snapshot, payload)
      // The worker posts after every poll, which keeps the worktree badges current too.
      void loadLinks()
    })
  )
  void plugin.request('notifications.list').then((s) => set(snapshot, s))
  void loadLinks()
}

async function loadLinks(): Promise<void> {
  try {
    set(orcaLinks, await plugin.request('orca.links'))
  } catch (e) {
    // The notification list is the point of the panel; worktree links are an extra.
    set(orcaLinks, { available: false, error: String((e as Error).message ?? e), links: {}, repos: [] })
  }
}

/** Runs a worktree action for one PR, keeps it marked busy, and reports a failure. */
async function worktreeAction(
  url: string,
  call: () => Promise<OrcaActionResult>
): Promise<void> {
  set(actionError, null)
  update(busy, (list) => [...list, url])
  try {
    const result = await call()
    if (!result.ok) set(actionError, result.error ?? 'The worktree action failed')
    await loadLinks()
  } finally {
    update(busy, (list) => list.filter((u) => u !== url))
  }
}

/** Links from GitHub's own notification list carry `notification_referrer_id`, which makes the
 *  PR page show its "Back to notifications / Done" bar. The worker works the token out. */
function withReferrer(item: GhNotification): string {
  if (!item.referrer) return item.url
  const u = new URL(item.url)
  u.searchParams.set('notification_referrer_id', item.referrer)
  // GitHub's own links also carry the list query the user came from.
  u.searchParams.set('notifications_query', 'is:unread')
  return u.toString()
}

function Item({
  item,
  showReason,
  orcaState,
  busyUrls
}: {
  item: GhNotification
  showReason: boolean
  orcaState: OrcaLinks | null
  busyUrls: string[]
}) {
  const isPr = item.type === 'PullRequest' && /\/pull\/\d+$/.test(item.url)
  const linked = isPr ? orcaState?.links[item.url.toLowerCase()] : undefined
  const canCreate =
    isPr && !linked && !!orcaState?.available && orcaState.repos.includes(item.repo.toLowerCase())
  const working = busyUrls.includes(item.url)
  const dimmed = item.state === 'merged' || item.state === 'closed'
  return (
    // Title on its own line so it can use the full width; the controls sit below, so a long
    // title can never push them past the panel's edge.
    <Stack gap="xs">
      <Text truncate muted={dimmed}>
        {item.title}
      </Text>
      <Row gap="xs" justify="between">
        <Row gap="xs">
          {item.state && STATES[item.state].tone ? (
            <Badge tone={STATES[item.state].tone ?? undefined}>{STATES[item.state].label}</Badge>
          ) : item.state ? (
            <Box direction="row" align="center" gap="xs" paddingX="sm" radius="full" border shrink={false}>
              <Text
                size="xs"
                tone={item.state === 'closed' ? 'danger' : item.state === 'open' ? 'success' : undefined}
                muted={item.state === 'merged'}
              >
                ●
              </Text>
              <Text size="xs" muted={item.state !== 'open'}>
                {STATES[item.state].label}
              </Text>
            </Box>
          ) : null}
        {showReason ? (
          <Row gap="xs">
            <Badge>{REASONS[item.reason] ?? item.reason}</Badge>
            {item.author ? (
              <Text muted size="xs" truncate>
                {`@${item.author}`}
              </Text>
            ) : null}
          </Row>
        ) : (
          <Text muted size="xs" truncate>
            {item.author ? `${item.repo} · @${item.author}` : item.repo}
          </Text>
        )}
        </Row>
        <Row gap="xs">
          {linked ? (
            <Badge tone="accent">{linked.name}</Badge>
          ) : null}
          {linked ? (
            <IconButton
              icon="branch"
              label={`Go to worktree ${linked.name}`}
              tooltip={`Go to worktree: ${linked.name}`}
              variant="ghost"
              size="sm"
              disabled={working}
              onPress={() =>
                worktreeAction(item.url, () => plugin.request('orca.openWorktree', { id: linked.id }))
              }
            />
          ) : null}
          {canCreate ? (
            <IconButton
              icon="add"
              label={`Review ${item.title} in a new worktree`}
              tooltip="Review in a new worktree"
              variant="ghost"
              size="sm"
              disabled={working}
              onPress={() =>
                worktreeAction(item.url, () =>
                  plugin.request('orca.reviewInWorktree', { url: item.url })
                )
              }
            />
          ) : null}
          <IconButton
            icon="open-external"
            label={`Open ${item.title} on GitHub`}
            tooltip="Open on GitHub"
            variant="ghost"
            size="sm"
            onPress={() => host.call('shell.openExternal', { url: withReferrer(item) })}
          />
          <IconButton
            icon="check"
            label={`Mark ${item.title} as done`}
            tooltip="Mark as done"
            variant="ghost"
            size="sm"
            onPress={() => void markDone(item.id)}
          />
        </Row>
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const snap = read(snapshot)
  const reviewsOnly = read(onlyReviews)
  const by = read(groupBy)
  const confirming = read(confirmingAll)
  const orca = read(orcaLinks)
  const busyUrls = read(busy)
  const isRefreshing = read(refreshing)
  const menu = read(menuOpen)
  const shown = read(shownCounts)
  const errors = [snap?.error, read(requestError), read(actionError)].filter(
    (m, i, all): m is string => !!m && all.indexOf(m) === i
  )
  const all = snap?.items ?? []
  const items = reviewsOnly ? all.filter((i) => i.reason === 'review_requested') : all
  const count = `${items.length}${snap?.truncated && !reviewsOnly ? '+' : ''}`
  const groups = groupItems(items, by)

  return (
    <Stack gap="md">
      {errors.map((message) => (
        <Callout key={message} tone="danger" title="Something went wrong" icon="error">
          {message}
        </Callout>
      ))}
      <Row gap="sm" justify="between">
        <Row gap="sm" wrap>
          <Heading>GitHub notifications</Heading>
          {/* The count gives way to a spinner while loading or refreshing by hand. */}
          {snap === null || isRefreshing ? (
            <Spinner label="Refreshing" labelHidden />
          ) : (
            <Badge tone="accent">{count}</Badge>
          )}
          {/* The filter lives in the menu, so a filtered list says so here. */}
          {reviewsOnly ? <Badge>Reviews only</Badge> : null}
        </Row>
        <IconButton
          icon="more"
          label="Settings"
          tooltip="Settings"
          variant="ghost"
          size="sm"
          onPress={() => update(menuOpen, (v) => !v)}
        />
      </Row>
      {menu ? (
        <Card title="Settings">
          <Stack gap="lg">
            <RadioGroup
              label="Show"
              orientation="horizontal"
              value={reviewsOnly ? 'reviews' : 'all'}
              options={[
                { value: 'all', label: 'All' },
                { value: 'reviews', label: 'Reviews' }
              ]}
              onChange={(v) => set(onlyReviews, v === 'reviews')}
            />
            <RadioGroup
              label="Group by"
              orientation="horizontal"
              value={by}
              options={[
                { value: 'repo', label: 'Repo' },
                { value: 'reason', label: 'Type' }
              ]}
              onChange={(v) => set(groupBy, v === 'repo' ? 'repo' : 'reason')}
            />
            <Separator />
            {/* Both actions look alike: outline, small, with an icon. */}
            <Row gap="sm" wrap>
              {/* While refreshing, the spinner takes the place of the refresh icon. */}
              <Button
                icon={isRefreshing ? undefined : 'refresh'}
                variant="outline"
                size="sm"
                disabled={isRefreshing}
                onPress={refresh}
              >
                {isRefreshing ? (
                  <Row gap="xs">
                    <Spinner label="Refreshing" labelHidden />
                    <Text>Refresh</Text>
                  </Row>
                ) : (
                  'Refresh'
                )}
              </Button>
              <Button
                icon="check"
                variant="outline"
                size="sm"
                disabled={all.length === 0}
                onPress={() => {
                  set(confirmingAll, true)
                  set(menuOpen, false)
                }}
              >
                Mark all read…
              </Button>
            </Row>
            {snap && snap.fetchedAt > 0 ? (
              <Text size="xs" muted>
                Last fetched <RelativeTime at={snap.fetchedAt} />
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : null}
      {snap && snap.pending > 0 ? (
        <Row gap="xs" align="center" wrap>
          <Text size="sm">
            {snap.pending === 1 ? '1 marked as done' : `${snap.pending} marked as done`}
          </Text>
          <Button
            size="sm"
            variant="outline"
            icon="refresh"
            onPress={() => run(() => plugin.request('notifications.undo'))}
          >
            Undo
          </Button>
        </Row>
      ) : null}
      {confirming ? (
        <Row gap="xs" wrap>
          <Text size="sm">Mark all {count} read on GitHub?</Text>
          <Button
            size="sm"
            tone="danger"
            onPress={async () => {
              set(confirmingAll, false)
              await run(() => plugin.request('notifications.markAllRead'))
            }}
          >
            Mark all read
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(confirmingAll, false)}>
            Cancel
          </Button>
        </Row>
      ) : null}
      {orca && !orca.available ? (
        <Text muted size="xs">
          Worktree buttons are off: {orca.error ?? 'the orca CLI is not reachable'}
        </Text>
      ) : null}
      {snap !== null && snap.fetchedAt > 0 && items.length === 0 && !snap.error ? (
        <Text muted>Nothing unread.</Text>
      ) : null}
      {groups.map((g) => {
        const groupKey = `${by}:${g.key}`
        const limit = shown[groupKey] ?? PAGE
        const hidden = g.items.length - limit
        return (
          <Collapsible key={groupKey} title={`${g.title} (${g.items.length})`} defaultOpen={g.open}>
            <Stack gap="lg">
              {g.items.slice(0, limit).map((i) => (
                <Item
                  key={i.id}
                  item={i}
                  showReason={by === 'repo'}
                  orcaState={orca}
                  busyUrls={busyUrls}
                />
              ))}
              {hidden > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => update(shownCounts, (m) => ({ ...m, [groupKey]: limit + PAGE }))}
                >
                  {`Show ${Math.min(PAGE, hidden)} more (${hidden} hidden)`}
                </Button>
              ) : null}
            </Stack>
          </Collapsible>
        )
      })}
    </Stack>
  )
}
