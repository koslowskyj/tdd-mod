import type { EngineInterface, Register, SessionMessage, TurnStepToolUse } from 'claude-code'
import { bashWriteTargets } from './bash.ts'
import { applyCalls, batchFor, filesOf, type WriteCall } from './batch.ts'
import { isInProject, isInScope, isTestFile, readConfig, type Config } from './config.ts'
import { runEval } from './eval.ts'
import { classifyTask, decide, type Complete, type Pending, type Usage } from './guard.ts'
import { isGuardInstruction, type TaskKind } from './task.ts'
import { evidenceOf, lastTestRun, nextStep, toHistory, type Change, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

// $.ui.log refuses a line over 4096 characters; leave room for the header.
const LOG_CHUNK = 3800
// The engine runs a tool while the rest of its response still streams in; a
// write waits this long for the whole response, so it is judged with the
// writes sent beside it. The wait counts against the hook's 10 s budget (the
// `$` calls before it and the model calls after it do not), and a hook past
// it is skipped, its write let through: 8 s leaves 2 s for the hook's own code.
const BATCH_WAIT_MS = 8000

/**
 * `byEvidence`: verdicts by write and evidence, so an identical retry with
 * nothing new gets the same answer; `byWrite`: the latest verdict per write,
 * to log a retry that reverses it.
 */
type Verdicts = { byEvidence: Map<string, Verdict>; byWrite: Map<string, Verdict['kind']> }

/** The task labels writes are judged by: the main session's, and each subagent's from its brief. */
type Labels = {
  main: () => TaskKind
  agents: ReadonlyMap<string, TaskKind>
  late: Map<string, Promise<TaskKind | undefined>>
  running: Set<string>
  status: () => string
}

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
  const inScope = (path: string, root: string) => isInScope(path, config) && isInProject(path, root)
  // The writes the judge sees: source files of the project that are not tests.
  const judgedIn = (root: string) => (path: string) => inScope(path, root) && !isTestFile(path, root)

  // The main session's task kind, from the latest typed prompt. Starts as
  // coding, also after a reload, so the guard is on until a prompt says otherwise.
  let task: TaskKind = 'coding'
  // Each subagent's own kind, from its brief, by agentId. One spawned before a
  // reload has none and is labelled late, at its first write (labels.late).
  const agents = new Map<string, TaskKind>()
  // The coding subagents whose run has not ended, for the status line.
  const running = new Set<string>()
  const status = () => {
    const main = task === 'coding' ? 'TDD on' : 'TDD off (not coding)'
    const n = running.size
    return n === 0 ? main : `${main} · judging ${n} subagent${n === 1 ? '' : 's'}`
  }
  const labels: Labels = { main: () => task, agents, late: new Map(), running, status }
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
    const complete: Complete = (request, options) => $.model.complete(request, options)
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
    const root = await projectRoot($)
    if (!inScope(e.file_path, root) || !(await judging($, config, labels, e.agentId))) return next(e)
    if (isTestFile(e.file_path, root)) {
      await shown($, await now($), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const call: WriteCall = { tool: 'Write', file_path: e.file_path, content: e.content }
    const verdict = await judgeCall($, config, verdicts, steps.get(e.agentId ?? ''), judgedIn(root), e.agentId, call)
    return verdict?.kind === 'violation' ? { deny: denial(verdict) } : next(e)
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const root = await projectRoot($)
    if (!inScope(e.file_path, root) || !(await judging($, config, labels, e.agentId))) return next(e)
    if (isTestFile(e.file_path, root)) {
      await shown($, await now($), 'pass', e.file_path, 'test file')
      return next(e)
    }
    const call: WriteCall = { tool: 'Edit', file_path: e.file_path, old_string: e.old_string, new_string: e.new_string, replace_all: e.replace_all }
    const verdict = await judgeCall($, config, verdicts, steps.get(e.agentId ?? ''), judgedIn(root), e.agentId, call)
    return verdict?.kind === 'violation' ? { deny: denial(verdict) } : next(e)
  })

  // Shell writes bypass the TDD check: send them through Write/Edit instead.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const targets = bashWriteTargets(e.command, judgedIn(await projectRoot($)))
    if (targets.length === 0 || !(await judging($, config, labels, e.agentId))) return next(e)
    $.ui.log(`tdd-mod: violation (bash write) ${targets.join(', ')}`, { to: 'debug' })
    return {
      deny:
        `tdd-mod: this command writes to ${targets.join(', ')}. Create and change ` +
        'source files with the Write or Edit tool, so the TDD check can judge the change.',
    }
  })

  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const root = await projectRoot($)
    if (!inScope(e.notebook_path, root) || !(await judging($, config, labels, e.agentId))) return next(e)
    if (isTestFile(e.notebook_path, root)) {
      await shown($, await now($), 'pass', e.notebook_path, 'test file')
      return next(e)
    }
    const started = await now($)
    const before = await readBefore($, e.notebook_path)
    const mode = e.edit_mode ?? 'replace'
    const content =
      `Notebook cell edit (${mode}) on cell ${e.cell_id ?? '(first)'}` +
      `${e.cell_type ? `, type ${e.cell_type}` : ''}. New cell source:\n\n${e.new_source}`
    const verdict = await judgeWrite($, config, verdicts, started, e.agentId, before, { path: e.notebook_path, content })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })
}

/** Whether the writes of `agentId`'s loop are judged; absent, the main session's. */
async function judging($: EngineInterface, config: Config, labels: Labels, agentId: string | undefined): Promise<boolean> {
  if (agentId === undefined) return labels.main() === 'coding'
  const kind = labels.agents.get(agentId) ?? (await labelLateOnce($, config, labels, agentId))
  return (kind ?? labels.main()) === 'coding'
}

/** labelLate, once per agent: the pending label is stored, so writes racing in classify its brief once. */
function labelLateOnce($: EngineInterface, config: Config, labels: Labels, agentId: string): Promise<TaskKind | undefined> {
  let label = labels.late.get(agentId)
  if (label === undefined) labels.late.set(agentId, (label = labelLate($, config, labels, agentId)))
  return label
}

/**
 * A subagent no agent.spawn hook saw (spawned before a reload) is labelled
 * from its brief, read back from its own transcript; undefined follows the
 * main session.
 */
async function labelLate($: EngineInterface, config: Config, labels: Labels, agentId: string): Promise<TaskKind | undefined> {
  if (!config.classifyTasks) return undefined
  const brief = briefOf(await $.session.messages({ agentId }))
  if (brief === undefined) {
    $.ui.log(`tdd-mod: subagent ${agentId} has no brief to label; it follows the main task`, { to: 'debug' })
    return undefined
  }
  // A failed call counts as coding, as classifyTask has it; a refused one too,
  // instead of failing the hook, which would let the write through unjudged.
  const failed = (why: string) => $.ui.log(`tdd-mod: subagent ${agentId} not classified (${why}); judged as coding`, { to: 'debug' })
  const complete: Complete = async request => {
    const reply = await $.model.complete(request)
    if (!reply.isAnswered) failed(reply.reason)
    return reply
  }
  const kind = await classifyTask(complete, config, brief, 'coding').catch((error: unknown) => {
    failed(error instanceof Error ? error.message : String(error))
    return 'coding' as const
  })
  $.ui.log(`tdd-mod: subagent ${agentId} labelled late (${kind}): ${excerpt(brief)}`, { to: 'debug' })
  if (kind === 'coding') {
    labels.running.add(agentId)
    $.ui.status(labels.status())
  }
  return kind
}

/** A subagent's brief: the first user message with text in its transcript; undefined when unreadable or none. */
function briefOf(messages: readonly SessionMessage[] | { deny: string }): string | undefined {
  return Array.isArray(messages) ? messages.find(m => m.role === 'user' && m.text.trim() !== '')?.text : undefined
}

async function readBefore($: EngineInterface, path: string): Promise<FileContent> {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'absent' }
    return { kind: 'present', content: await $.fs.read(path) }
  } catch {
    return { kind: 'unknown' }
  }
}

/** The project root, so a test folder is told apart from the folder the checkout lives in; '' when unknown. */
async function projectRoot($: EngineInterface): Promise<string> {
  try {
    return await $.session.root()
  } catch {
    return ''
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
  // From the write's call, so the wait for its response counts in the logged latency.
  const started = await now($)
  const batch = step && (await wholeResponse($, step)) ? batchFor(step.uses, call, judged) : [call]
  if (batch.length > 1 && step?.verdict) {
    const verdict = await step.verdict
    await shown($, started, verdict.kind, call.file_path, `batch of ${batch.length}`)
    return verdict
  }
  const together = batch.length > 1 ? await changesOf($, batch, call) : undefined
  // A batch that no longer applies (one of its writes already ran unjudged): this write alone.
  const changes = together ?? (await changesOf($, [call], call))
  const [main, ...also] = changes ?? []
  if (main === undefined) return undefined
  const verdict = judgeWrite($, config, verdicts, started, agentId, main.before, { path: main.path, content: main.content }, also)
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
  started: number,
  agentId: string | undefined,
  before: FileContent,
  pending: Pending,
  also: readonly Change[] = [],
): Promise<Verdict> {
  const history = await recentHistory($, agentId)
  // The write (who, where, from what to what), and that write with the evidence its verdict rests on.
  const write = `${pending.path} ${hash(JSON.stringify([agentId ?? null, before, pending.content, also]))}`
  const key = `${write} ${hash(evidenceOf(history))}`
  const cached = verdicts.byEvidence.get(key)
  if (cached) {
    await shown($, started, cached.kind, pending.path, 'cached')
    return cached
  }
  const complete: Complete = (request, options) => $.model.complete(request, options)
  const decision = await decide(complete, config, async () => history, before, pending, also)
  const which = (i: number) => (decision.fastPath ? 'fast path: one new test' : i === 0 ? 'first opinion' : 'second opinion')
  decision.opinions.forEach((verdict, i) => log($, verdict, pending, which(i)))
  if (decision.verdict.kind === 'violation' && decision.prompt) logPrompt($, decision.prompt, pending)
  await shown($, started, decision.verdict.kind, pending.path, which(decision.opinions.length - 1), decision.usage)
  const previous = verdicts.byWrite.get(write)
  if (previous !== undefined && previous !== decision.verdict.kind) {
    $.ui.log(`tdd-mod: verdict reversed on retry (${previous} → ${decision.verdict.kind}) ${pending.path}`, { to: 'debug' })
  }
  // A block the judge answered says what to do next; a missing answer already says retry.
  const verdict = decision.verdict.kind === 'violation' && !decision.verdict.unanswered ? { ...decision.verdict, next: nextStep(lastTestRun(history)) } : decision.verdict
  if (!verdict.unanswered) verdicts.byEvidence.set(key, verdict)
  verdicts.byWrite.set(write, verdict.kind)
  return verdict
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
async function shown($: EngineInterface, started: number, kind: Verdict['kind'], path: string, how: string, usage?: Usage): Promise<void> {
  const tokens = usage && usage.input + usage.output > 0 ? `, ${usage.input} in / ${usage.output} out tokens` : ''
  $.ui.log(`tdd-mod: ${kind} ${path} (${how}, ${(await now($)) - started} ms${tokens})`)
}

/** The host's time, the one the batch wait runs on; the process's when the host has none. */
async function now($: EngineInterface): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
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
  return verdict.next ? `tdd-mod: ${verdict.reason}\n${verdict.next}` : `tdd-mod: ${verdict.reason}`
}
