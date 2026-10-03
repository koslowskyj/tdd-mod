import type { EngineInterface, Register } from 'claude-code'
import { bashWriteTargets } from './bash.ts'
import { isInScope, readConfig, type Config } from './config.ts'
import { runEval } from './eval.ts'
import { classifyTask, decide, type Complete, type Pending } from './guard.ts'
import { isGuardInstruction, type TaskKind } from './task.ts'
import { applyEdit, toHistory, trimHistory, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

// $.ui.log refuses a line over 4096 characters; leave room for the header.
const LOG_CHUNK = 3800

export const register: Register = (on, options) => {
  const config = readConfig(options)
  if (!config.enabled) return
  const inScope = (path: string) => isInScope(path, config)

  // The kind of the task at hand, from the latest prompt. Starts as coding,
  // also after a reload, so the guard is on until a prompt says otherwise.
  let task: TaskKind = 'coding'
  const judging = () => task === 'coding'

  on('session.start', async ($, e, next) => {
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
    $.ui.status(task === 'coding' ? 'TDD on' : 'TDD off (not coding)')
    $.ui.log(`tdd-mod: task ${task}: ${e.text.slice(0, 80).replace(/\s+/g, ' ')}`, { to: 'debug' })
    return next(e)
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!judging() || !inScope(e.file_path)) return next(e)
    const before = await readBefore($, e.file_path)
    const verdict = await judgeWrite($, config, e.agentId, before, { path: e.file_path, content: e.content })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!judging() || !inScope(e.file_path)) return next(e)
    const before = await readBefore($, e.file_path)
    if (before.kind !== 'present') return next(e)
    const after = applyEdit(before.content, e.old_string, e.new_string, e.replace_all)
    // An edit that cannot apply changes nothing; the Edit tool reports the miss.
    if (after === undefined) return next(e)
    const verdict = await judgeWrite($, config, e.agentId, before, { path: e.file_path, content: after })
    return verdict.kind === 'pass' ? next(e) : { deny: denial(verdict) }
  })

  // Shell writes bypass the TDD check: send them through Write/Edit instead.
  on('tool.call', { tool: 'Bash' }, ($, e, next) => {
    if (!judging()) return next(e)
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
    if (!judging() || !inScope(e.notebook_path)) return next(e)
    const before = await readBefore($, e.notebook_path)
    const mode = e.edit_mode ?? 'replace'
    const content =
      `Notebook cell edit (${mode}) on cell ${e.cell_id ?? '(first)'}` +
      `${e.cell_type ? `, type ${e.cell_type}` : ''}. New cell source:\n\n${e.new_source}`
    const verdict = await judgeWrite($, config, e.agentId, before, { path: e.notebook_path, content })
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
  agentId: string | undefined,
  before: FileContent,
  pending: Pending,
): Promise<Verdict> {
  const complete: Complete = request => $.model.complete(request)
  const decision = await decide(complete, config, () => recentHistory($, agentId), before, pending)
  decision.opinions.forEach((verdict, i) =>
    log($, verdict, pending, decision.fastPath ? 'fast path: one new test' : i === 0 ? 'first opinion' : 'second opinion'),
  )
  if (decision.verdict.kind === 'violation' && decision.prompt) logPrompt($, decision.prompt, pending)
  return decision.verdict
}

async function recentHistory($: EngineInterface, agentId: string | undefined): Promise<HistoryEvent[]> {
  const messages = await $.session.messages(agentId === undefined ? {} : { agentId })
  return trimHistory(Array.isArray(messages) ? toHistory(messages) : [])
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

function denial(verdict: Verdict): string {
  return `tdd-mod: ${verdict.reason}`
}
