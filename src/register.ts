import type { EngineInterface, Register } from 'claude-code'
import { bashWriteTargets } from './bash.ts'
import { isInScope, isTestFile, readConfig, type Config } from './config.ts'
import { runEval } from './eval.ts'
import { classifyTask, decide, type Complete, type Pending } from './guard.ts'
import { isGuardInstruction, type TaskKind } from './task.ts'
import { applyEdit, evidenceOf, toHistory, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

// $.ui.log refuses a line over 4096 characters; leave room for the header.
const LOG_CHUNK = 3800

/**
 * `byEvidence`: verdicts by write and evidence, so an identical retry with
 * nothing new gets the same answer; `byWrite`: the latest verdict per write,
 * to log a retry that reverses it.
 */
type Verdicts = { byEvidence: Map<string, Verdict>; byWrite: Map<string, Verdict['kind']> }

export const register: Register = (on, options) => {
  const config = readConfig(options)
  if (!config.enabled) return
  const inScope = (path: string) => isInScope(path, config)

  // The main session's task kind, from the latest typed prompt. Starts as
  // coding, also after a reload, so the guard is on until a prompt says otherwise.
  let task: TaskKind = 'coding'
  // Each subagent's own kind, from its brief, by agentId. One spawned before a
  // reload, or by no Agent call, has none and follows the main session.
  const agents = new Map<string, TaskKind>()
  // The coding subagents whose run has not ended, for the status line.
  const running = new Set<string>()
  const judging = (agentId: string | undefined) =>
    ((agentId === undefined ? undefined : agents.get(agentId)) ?? task) === 'coding'
  const status = () => {
    const main = task === 'coding' ? 'TDD on' : 'TDD off (not coding)'
    const n = running.size
    return n === 0 ? main : `${main} · judging ${n} subagent${n === 1 ? '' : 's'}`
  }
  const verdicts: Verdicts = { byEvidence: new Map(), byWrite: new Map() }

  on('session.start', async ($, e, next) => {
    for (const problem of config.problems) $.ui.log(`tdd-mod: ${problem}`)
    await $.command.register({
      name: 'tdd-eval',
      description: 'Replays the tdd-mod regression cases through the configured models.',
      argumentHint: '[runs per case]',
    })
    return next(e)
  })

  on('command.run', { command: 'tdd-eval' }, async ($, e) => {
    const runs = Math.max(1, Math.min(10, Number.parseInt(e.args, 10) || 3))
    const complete: Complete = request => $.model.complete(request)
    const root = $.plugin.root
    const text = await runEval(complete, file => $.fs.read(`${root}/eval/${file}`), config, runs)
    return { text }
  })

  // Only what the person types changes the task; notifications and messages
  // from other agents arrive as prompts too, and keep it.
  on('prompt.submit', async ($, e, next) => {
    if (!config.classifyTasks || e.origin.kind !== 'composer' || isGuardInstruction(e.text)) return next(e)
    task = await classifyTask(request => $.model.complete(request), config, e.text, task)
    $.ui.status(status())
    $.ui.log(`tdd-mod: task ${task}: ${excerpt(e.text)}`, { to: 'debug' })
    return next(e)
  })

  // A subagent's task is its brief, not the prompt the person last typed.
  on('agent.spawn', async ($, e, next) => {
    if (!config.classifyTasks) return next(e)
    const kind = await classifyTask(request => $.model.complete(request), config, e.prompt, 'coding')
    const spawned = await next(e)
    const { agentId } = spawned
    if (agentId === undefined) return spawned
    agents.set(agentId, kind)
    if (kind === 'coding') running.add(agentId)
    $.ui.status(status())
    $.ui.log(`tdd-mod: subagent ${agentId} task ${kind}: ${excerpt(e.prompt)}`, { to: 'debug' })
    return spawned
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId !== undefined && running.delete(e.agentId)) $.ui.status(status())
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!judging(e.agentId) || !inScope(e.file_path)) return next(e)
    if (isTestFile(e.file_path)) {
      shown($, Date.now(), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const before = await readBefore($, e.file_path)
    const verdict = await judgeWrite($, config, verdicts, e.agentId, before, { path: e.file_path, content: e.content })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!judging(e.agentId) || !inScope(e.file_path)) return next(e)
    if (isTestFile(e.file_path)) {
      shown($, Date.now(), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const before = await readBefore($, e.file_path)
    if (before.kind !== 'present') return next(e)
    const after = applyEdit(before.content, e.old_string, e.new_string, e.replace_all)
    // An edit that cannot apply changes nothing; the Edit tool reports the miss.
    if (after === undefined) return next(e)
    const verdict = await judgeWrite($, config, verdicts, e.agentId, before, { path: e.file_path, content: after })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })

  // Shell writes bypass the TDD check: send them through Write/Edit instead.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (!judging(e.agentId)) return next(e)
    const targets = bashWriteTargets(e.command, inScope)
    if (targets.length === 0) return next(e)
    $.ui.log(`tdd-mod: violation (bash write) ${targets.join(', ')}`, { to: 'debug' })
    return {
      deny:
        `tdd-mod: this command writes to ${targets.join(', ')}. Create and change ` +
        'source files with the Write or Edit tool, so the TDD check can judge the change.',
    }
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    if (!judging(e.agentId) || !inScope(e.notebook_path)) return next(e)
    const before = await readBefore($, e.notebook_path)
    const mode = e.edit_mode ?? 'replace'
    const content =
      `Notebook cell edit (${mode}) on cell ${e.cell_id ?? '(first)'}` +
      `${e.cell_type ? `, type ${e.cell_type}` : ''}. New cell source:\n\n${e.new_source}`
    const verdict = await judgeWrite($, config, verdicts, e.agentId, before, { path: e.notebook_path, content })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })
}

async function readBefore($: EngineInterface, path: string): Promise<FileContent> {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'absent' }
    return { kind: 'present', content: await $.fs.read(path) }
  } catch {
    return { kind: 'unknown' }
  }
}

async function judgeWrite(
  $: EngineInterface,
  config: Config,
  verdicts: Verdicts,
  agentId: string | undefined,
  before: FileContent,
  pending: Pending,
): Promise<Verdict> {
  const started = Date.now()
  const history = await recentHistory($, agentId)
  // The write (who, where, from what to what), and that write with the evidence its verdict rests on.
  const write = `${pending.path} ${hash(JSON.stringify([agentId ?? null, before, pending.content]))}`
  const key = `${write} ${hash(evidenceOf(history))}`
  const cached = verdicts.byEvidence.get(key)
  if (cached) {
    shown($, started, cached.kind, pending.path, 'cached')
    return cached
  }
  const complete: Complete = request => $.model.complete(request)
  const decision = await decide(complete, config, async () => history, before, pending)
  const which = (i: number) => (decision.fastPath ? 'fast path: one new test' : i === 0 ? 'first opinion' : 'second opinion')
  decision.opinions.forEach((verdict, i) => log($, verdict, pending, which(i)))
  if (decision.verdict.kind === 'violation' && decision.prompt) logPrompt($, decision.prompt, pending)
  shown($, started, decision.verdict.kind, pending.path, which(decision.opinions.length - 1))
  const previous = verdicts.byWrite.get(write)
  if (previous !== undefined && previous !== decision.verdict.kind) {
    $.ui.log(`tdd-mod: verdict reversed on retry (${previous} → ${decision.verdict.kind}) ${pending.path}`, { to: 'debug' })
  }
  verdicts.byEvidence.set(key, decision.verdict)
  verdicts.byWrite.set(write, decision.verdict.kind)
  return decision.verdict
}

/** cyrb53: a fast 53-bit string hash, so the verdict cache keeps no file contents. */
function hash(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** One transcript line per decision, passes included, with how it was reached and how long it took. */
function shown($: EngineInterface, started: number, kind: Verdict['kind'], path: string, how: string): void {
  $.ui.log(`tdd-mod: ${kind} ${path} (${how}, ${Date.now() - started} ms)`)
}

/** The agent's whole session: buildPrompt shows its recent part and its last test run. */
async function recentHistory($: EngineInterface, agentId: string | undefined): Promise<HistoryEvent[]> {
  const messages = await $.session.messages(agentId === undefined ? {} : { agentId })
  return Array.isArray(messages) ? toHistory(messages) : []
}

function log($: EngineInterface, verdict: Verdict, pending: Pending, which: string): void {
  const reason = verdict.reason ? ` — ${verdict.reason}` : ''
  $.ui.log(`tdd-mod: ${verdict.kind} (${which}) ${pending.path}${reason}`, { to: 'debug' })
}

/** The blocked write's prompt, in numbered parts, so it can be replayed exactly. */
function logPrompt($: EngineInterface, prompt: string, pending: Pending): void {
  const parts = Math.ceil(prompt.length / LOG_CHUNK)
  for (let i = 0; i < parts; i++) {
    const part = prompt.slice(i * LOG_CHUNK, (i + 1) * LOG_CHUNK)
    $.ui.log(`tdd-mod: blocked prompt ${pending.path} part ${i + 1}/${parts}:\n${part}`, { to: 'debug' })
  }
}

/** The start of a prompt, on one line, for the debug log. */
function excerpt(text: string): string {
  return text.slice(0, 80).replace(/\s+/g, ' ')
}

function denial(verdict: Verdict): string {
  return `tdd-mod: ${verdict.reason}`
}
