// /tdd-eval: replays the regression cases in eval/ through the same decisions
// a session makes, with the configured models, and reports the hit rate.
import type { Config } from './config.ts'
import { classifyTask, decide, type Complete, type Pending } from './guard.ts'
import { isGuardInstruction, type TaskKind } from './task.ts'
import type { FileContent, HistoryEvent } from './tdd.ts'

export type VerdictCase = {
  name: string
  expect: 'pass' | 'violation'
  /** Why this is the right verdict, for whoever reads a failure. */
  why: string
  history: HistoryEvent[]
  before: FileContent
  pending: Pending
}

export type TaskCase = { text: string; previous: TaskKind; expect: TaskKind }

const CONCURRENCY = 6

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
  const results: T[] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++
      results[i] = await (jobs[i] as () => Promise<T>)()
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, worker))
  return results
}

/** Reads a file of eval/ by name; the hooks module passes `$.fs.read` in. */
export type ReadEvalFile = (file: string) => Promise<string>

function row(hits: number, runs: number, label: string): string {
  return `${hits === runs ? '✓' : '✗'} ${hits}/${runs}  ${label}`
}

export async function runEval(complete: Complete, read: ReadEvalFile, config: Config, runs: number): Promise<string> {
  const verdictCases = JSON.parse(await read('verdicts.json')) as VerdictCase[]
  const taskCases = JSON.parse(await read('tasks.json')) as TaskCase[]
  const lines: string[] = []

  const verdictJobs = verdictCases.flatMap(c =>
    Array.from({ length: runs }, () => () => decide(complete, config, async () => c.history, c.before, c.pending)),
  )
  const decisions = await pool(verdictJobs, CONCURRENCY)
  let verdictHits = 0
  lines.push(
    `Verdicts — model ${config.judgeModel}, fast path ${config.fastPath ? 'on' : 'off'}, ` +
      `second opinion ${config.secondOpinion ? 'on' : 'off'}, ${runs} runs each`,
  )
  verdictCases.forEach((c, i) => {
    const mine = decisions.slice(i * runs, (i + 1) * runs)
    const hits = mine.filter(d => d.verdict.kind === c.expect).length
    verdictHits += hits
    lines.push(row(hits, runs, `expect ${c.expect.padEnd(9)} ${c.name}`))
    const miss = mine.find(d => d.verdict.kind !== c.expect)
    if (miss) lines.push(`         got ${miss.verdict.kind}: ${miss.verdict.reason.slice(0, 160)}`)
  })

  const taskJobs = taskCases.flatMap(c =>
    Array.from({ length: runs }, () => async () =>
      isGuardInstruction(c.text) ? c.previous : classifyTask(complete, config, c.text, c.previous),
    ),
  )
  const kinds = await pool(taskJobs, CONCURRENCY)
  let taskHits = 0
  lines.push('', `Tasks — model ${config.classifierModel}, ${runs} runs each`)
  taskCases.forEach((c, i) => {
    const hits = kinds.slice(i * runs, (i + 1) * runs).filter(k => k === c.expect).length
    taskHits += hits
    lines.push(row(hits, runs, `expect ${c.expect.padEnd(6)} (after ${c.previous}) ${c.text.slice(0, 70)}`))
  })

  const verdictTotal = verdictCases.length * runs
  const taskTotal = taskCases.length * runs
  lines.push('', `Verdicts ${verdictHits}/${verdictTotal}, tasks ${taskHits}/${taskTotal}`)
  return lines.join('\n')
}
