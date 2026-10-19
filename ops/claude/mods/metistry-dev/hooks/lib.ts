// Pure functions of the metistry-dev mod. No engine calls here, so node --test can run them.

/** The commit trailer docs/ops/agent-brief.md "How you finish" requires. */
export const COMMIT_TRAILER =
  'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>'

/** The PR-description footer the same section requires. */
export const PR_FOOTER =
  '🤖 Generated with [Claude Code](https://claude.com/claude-code)'

const TRAILER_LINE = /^[ \t]*Co-Authored-By:.*$/im
const FOOTER_LINE = /^.*Generated with \[?Claude Code\]?.*$/im

/**
 * The text the model reads in place of the engine's own `attribution.text`.
 * `commit` and `pr` are rewritten; `exemption` and `remedy` (sentences about the
 * engine's own commit gate) are left exactly as composed.
 * If the engine's text already carries a line of the kind, that line is replaced
 * and the words around it stay; otherwise the required line is the whole text.
 */
export function rewriteAttribution(kind: string, text: string): string {
  if (kind === 'commit') {
    return TRAILER_LINE.test(text) ? text.replace(TRAILER_LINE, COMMIT_TRAILER) : COMMIT_TRAILER
  }
  if (kind === 'pr') {
    return FOOTER_LINE.test(text) ? text.replace(FOOTER_LINE, PR_FOOTER) : PR_FOOTER
  }
  return text
}

/** The last `n` non-empty lines of `text`, oldest first. */
export function tailLines(text: string, n: number): string[] {
  return text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0).slice(-n)
}

export type PrRow = { number: number; title: string; mergeStateStatus: string }

/** Parse `gh pr list --json number,title,mergeStateStatus`; anything malformed gives []. */
export function parsePrList(json: string): PrRow[] {
  try {
    const v: unknown = JSON.parse(json)
    if (!Array.isArray(v)) return []
    return v
      .filter(
        (r): r is PrRow =>
          typeof r === 'object' && r !== null &&
          typeof (r as PrRow).number === 'number' &&
          typeof (r as PrRow).title === 'string',
      )
      .map(r => ({
        number: r.number,
        title: r.title,
        mergeStateStatus: typeof r.mergeStateStatus === 'string' ? r.mergeStateStatus : 'UNKNOWN',
      }))
      .sort((a, b) => a.number - b.number)
  } catch {
    return []
  }
}

/** One display line per PR, cut to `width` columns. */
export function formatPr(pr: PrRow, width: number): string {
  const line = `#${pr.number} ${pr.mergeStateStatus.padEnd(9)} ${pr.title}`
  return line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line
}

/** The only command the pane ever runs. A constant: no input reaches this argv. */
export const GH_PR_LIST_ARGV: readonly string[] = Object.freeze([
  'env', '-u', 'GH_TOKEN', 'gh', 'pr', 'list',
  '--json', 'number,title,mergeStateStatus',
])

/** Where the coordinator keeps the queue, below $HOME. Read only, never written. */
export const QUEUE_REL_DIR =
  '.claude/projects/-Users-mattcolf-Development-Metistry/tools'
