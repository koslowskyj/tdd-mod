import type { EngineInterface, Register, TurnStepToolUse } from 'claude-code'
import { bashWriteTargets } from './bash.ts'
import { applyCalls, batchFor, filesOf, type WriteCall } from './batch.ts'
import { isInScope, isTestFile, readConfig, type Config } from './config.ts'
import { runEval } from './eval.ts'
import { classifyTask, decide, type Complete, type Pending } from './guard.ts'
import { isGuardInstruction, type TaskKind } from './task.ts'
import { evidenceOf, toHistory, type Change, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

// $.ui.log refuses a line over 4096 characters; leave room for the header.
const LOG_CHUNK = 3800
// The engine runs a tool while the rest of its response still streams in; a
// write waits this long for the whole response, so it is judged with the
// writes sent beside it. Well inside a hook's 10 s budget.
const BATCH_WAIT_MS = 3000

/**
 * `byEvidence`: verdicts by write and evidence, so an identical retry with
 * nothing new gets the same answer; `byWrite`: the latest verdict per write,
 * to log a retry that reverses it.
 */
type Verdicts = { byEvidence: Map<string, Verdict>; byWrite: Map<string, Verdict['kind']> }

/** One model response: the tool calls it asked for once whole, and the verdict on the writes it batches. */
type Step = { uses: readonly TurnStepToolUse[]; ended: boolean; whole: Promise<void>; end: () => void; verdict?: Promise<Verdict> }

function startStep(): Step {
  let resolve = () => {}
  const whole = new Promise<void>(r => (resolve = r))
  const step: Step = {
    uses: [],
    ended: false,
    whole,
    end: () => {
      step.ended = true
      resolve()
    },
  }
  return step
}

export const register: Register = (on, options) => {
  const config = readConfig(options)
  if (!config.enabled) return
  const inScope = (path: string) => isInScope(path, config)
  // The writes the guard judges: source files in scope, not tests (a test is the red step).
  const judged = (path: string) => inScope(path) && !isTestFile(path)

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
  // The latest model response of each loop (main: ''), whose tool calls are running now.
  const steps = new Map<string, Step>()

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

  // Remembers which tool calls each response asked for, so the writes sent
  // in one response can be judged together.
  on('turn.step', async function* ($, e, next) {
    const step = startStep()
    steps.set(e.agentId ?? '', step)
    try {
      const response = yield* next(e)
      step.uses = response.toolUses
      return response
    } finally {
      step.end()
    }
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!judging(e.agentId) || !inScope(e.file_path)) return next(e)
    if (isTestFile(e.file_path)) {
      shown($, Date.now(), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const call: WriteCall = { tool: 'Write', file_path: e.file_path, content: e.content }
    const verdict = await judgeCall($, config, verdicts, steps.get(e.agentId ?? ''), judged, e.agentId, call)
    return verdict?.kind === 'violation' ? { deny: denial(verdict) } : next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!judging(e.agentId) || !inScope(e.file_path)) return next(e)
    if (isTestFile(e.file_path)) {
      shown($, Date.now(), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const call: WriteCall = { tool: 'Edit', file_path: e.file_path, old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all }
    const verdict = await judgeCall($, config, verdicts, steps.get(e.agentId ?? ''), judged, e.agentId, call)
    return verdict?.kind === 'violation' ? { deny: denial(verdict) } : next(e)
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

/**
 * Judges a Write or Edit together with the other judged writes of the same
 * model response, on the files they leave together: the first of them is
 * judged, the rest get its verdict. Undefined when the write cannot apply;
 * the tool itself then reports that.
 */
async function judgeCall(
  $: EngineInterface,
  config: Config,
  verdicts: Verdicts,
  step: Step | undefined,
  judged: (path: string) => boolean,
  agentId: string | undefined,
  call: WriteCall,
): Promise<Verdict | undefined> {
  const started = Date.now()
  const batch = step && (await wholeResponse($, step)) ? batchFor(step.uses, call, judged) : [call]
  if (batch.length > 1 && step?.verdict) {
    const verdict = await step.verdict
    shown($, started, verdict.kind, call.file_path, `batch of ${batch.length}`)
    return verdict
  }
  const together = batch.length > 1 ? await changesOf($, batch, call) : undefined
  // A batch that no longer applies (one of its writes already ran unjudged): this write alone.
  const changes = together ?? (await changesOf($, [call], call))
  const [main, ...also] = changes ?? []
  if (main === undefined) return undefined
  const verdict = judgeWrite($, config, verdicts, agentId, main.before, { path: main.path, content: main.content }, also)
  if (together && step) step.verdict = verdict
  return verdict
}

/**
 * Each file `batch` writes, as it is and as the batch leaves it, `call`'s
 * file first; undefined when one of the writes cannot apply.
 */
async function changesOf($: EngineInterface, batch: readonly WriteCall[], call: WriteCall): Promise<Change[] | undefined> {
  const changes: Change[] = []
  for (const path of [call.file_path, ...filesOf(batch).filter(p => p !== call.file_path)]) {
    const before = await readBefore($, path)
    const content = applyCalls(path, before, batch)
    if (content === undefined) return undefined
    changes.push({ path, before, content })
  }
  return changes
}

/** Whether `step`'s response is whole, waiting up to BATCH_WAIT_MS for it. */
async function wholeResponse($: EngineInterface, step: Step): Promise<boolean> {
  if (step.ended) return true
  let timer: { cancel: () => void } | undefined
  const timeout = new Promise<void>(resolve => {
    try {
      timer = $.clock.after(BATCH_WAIT_MS, resolve)
    } catch {
      resolve()
    }
  })
  await Promise.race([step.whole, timeout])
  timer?.cancel()
  return step.ended
}

async function judgeWrite(
  $: EngineInterface,
  config: Config,
  verdicts: Verdicts,
  agentId: string | undefined,
  before: FileContent,
  pending: Pending,
  also: readonly Change[] = [],
): Promise<Verdict> {
  const started = Date.now()
  const history = await recentHistory($, agentId)
  // The write (who, where, from what to what), and that write with the evidence its verdict rests on.
  const write = `${pending.path} ${hash(JSON.stringify([agentId ?? null, before, pending.content, also]))}`
  const key = `${write} ${hash(evidenceOf(history))}`
  const cached = verdicts.byEvidence.get(key)
  if (cached) {
    shown($, started, cached.kind, pending.path, 'cached')
    return cached
  }
  const complete: Complete = request => $.model.complete(request)
  const decision = await decide(complete, config, async () => history, before, pending, also)
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
