import type { Register } from 'claude-code'

import {
  GH_PR_LIST_ARGV,
  QUEUE_REL_DIR,
  type PrRow,
  formatPr,
  parsePrList,
  rewriteAttribution,
  tailLines,
} from './lib'

const PANE = 'metistry-status'
const POLL_MS = 30_000

// A snapshot of what the last poll read. Held in the module, not in $.state: the pane
// is a display of files and `gh`, and a reload simply polls again.
type Snapshot = { queue: string; log: string[]; prs: PrRow[]; error: string; updatedAt: number }

export const register: Register = on => {
  let isOpen = false
  let snap: Snapshot = { queue: '', log: [], prs: [], error: '', updatedAt: 0 }

  // (1) MD-2: the trailer by construction. Rewrites the text the engine asks the
  // model to write; it does not touch git, and it cannot see a commit that was
  // written some other way (the commit-msg hook is the check, this is the writer).
  on('attribution.text', async ($, e, next) => {
    const composed = await next(e)
    return { text: rewriteAttribution(e.kind, composed.text) }
  })

  // (2) MD-3: a read-only pane. Reads two files and runs one fixed `gh pr list`.
  // The validator forbids passing `$` as an argument, so the poll is a closure
  // made inside session.start and kept in `refresh`.
  let refresh: () => Promise<void> = async () => {}

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'metistry-status',
      description: 'Open the read-only merge-queue and open-PR pane',
    })
    refresh = async () => {
      if (!isOpen) return
      let queue = ''
      let log: string[] = []
      let prs: PrRow[] = []
      const problems: string[] = []

      const home = await $.env.get('HOME')
      if (home) {
        const dir = `${home}/${QUEUE_REL_DIR}`
        try { queue = await $.fs.read(`${dir}/queue.txt`) } catch { problems.push('queue.txt unreadable') }
        try { log = tailLines(await $.fs.read(`${dir}/queue.log`), 12) } catch { problems.push('queue.log unreadable') }
      } else {
        problems.push('HOME unset')
      }
      try {
        const ran = await $.process.run(GH_PR_LIST_ARGV, { timeoutMs: 20_000 })
        if (ran.exitCode === 0) prs = parsePrList(ran.stdout)
        else problems.push(`gh exited ${ran.exitCode}`)
      } catch {
        problems.push('gh failed to run')
      }

      const now = await $.clock.now()
      snap = { queue, log, prs, error: problems.join('; '), updatedAt: now }
      $.ui.invalidate('ui.render')
    }
    $.clock.every(POLL_MS, () => { void refresh() })
    return next(e)
  })

  on('command.run', { command: 'metistry-status' }, async $ => {
    isOpen = true
    await $.ui.open({ id: PANE, title: 'Metistry queue' })
    void refresh()
    return { text: 'Metistry status pane opened (read-only; refreshes every 30 s).' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const s = snap
    const width = (e.viewport?.columns ?? 80) - 2
    const age = s.updatedAt === 0 ? 'not yet polled' : new Date(s.updatedAt).toLocaleTimeString()

    return (
      <Box flexDirection="column">
        <Text bold>Merge queue</Text>
        {(s.queue.trim() === '' ? ['(empty or unreadable)'] : s.queue.trimEnd().split('\n')).map(l => (
          <Text>{l.slice(0, width)}</Text>
        ))}
        <Text bold>queue.log</Text>
        {s.log.length === 0 && <Text dimColor>(none)</Text>}
        {s.log.map(l => <Text dimColor>{l.slice(0, width)}</Text>)}
        <Text bold>Open PRs</Text>
        {s.prs.length === 0 && <Text dimColor>(none or gh unavailable)</Text>}
        {s.prs.map(pr => <Text>{formatPr(pr, width)}</Text>)}
        {s.error !== '' && <Text color="red">{s.error}</Text>}
        <Text dimColor>updated {age}</Text>
      </Box>
    )
  })
}
