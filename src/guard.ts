// The guard's two decisions, shared by the session's hooks and /tdd-eval:
// which kind of task a prompt starts, and whether a write follows TDD.
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'
import type { Config } from './config.ts'
import { buildTaskPrompt, parseTaskKind, type TaskKind } from './task.ts'
import { addsExactlyOneTest, buildPrompt, parseVerdict, type Change, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

const TIMEOUT_MS = 120_000

export type Pending = { path: string; content: string }

/** A model call; the hooks module passes `$.model.complete` in, since `$` cannot cross an import. */
export type Complete = (request: ModelCompleteRequest) => Promise<ModelCompleteResult>

/** The task kind after `text`; a failed call counts as coding, so the guard stays on. */
export async function classifyTask(
  complete: Complete,
  config: Config,
  text: string,
  previous: TaskKind,
): Promise<TaskKind> {
  const reply = await complete({
    model: config.classifierModel,
    prompt: buildTaskPrompt(text, previous),
    maxTokens: 10,
    timeoutMs: TIMEOUT_MS,
  })
  return reply.isAnswered ? parseTaskKind(reply.text) : 'coding'
}

export type Decision = {
  verdict: Verdict
  /** Every verdict in order: the fast path's pass alone, or one or two model verdicts. */
  opinions: Verdict[]
  fastPath: boolean
  prompt?: string
}

/**
 * The guard's decision on one write, as a session makes it and /tdd-eval
 * replays it: the fast path, then the verdict model, then a second opinion.
 * `also`: the other files the write's batch changes, judged with it.
 */
export async function decide(
  complete: Complete,
  config: Config,
  history: () => Promise<HistoryEvent[]>,
  before: FileContent,
  pending: Pending,
  also: readonly Change[] = [],
): Promise<Decision> {
  // Adding one test is the red step itself.
  if (also.length === 0 && config.fastPath && addsExactlyOneTest(pending.path, before, pending.content, config.testPatterns)) {
    const verdict: Verdict = { kind: 'pass', reason: '' }
    return { verdict, opinions: [verdict], fastPath: true }
  }
  const prompt = buildPrompt(await history(), before, pending, also)
  const first = await ask(complete, config, prompt)
  if (first.kind === 'pass' || !config.secondOpinion) return { verdict: first, opinions: [first], fastPath: false, prompt }
  // A single validator call misfires now and then: block only when a second
  // opinion agrees. Still fail-closed: two failed calls block.
  const second = await ask(complete, config, prompt)
  return { verdict: second, opinions: [first, second], fastPath: false, prompt }
}

async function ask(complete: Complete, config: Config, prompt: string): Promise<Verdict> {
  const reply = await complete({ model: config.judgeModel, prompt, timeoutMs: TIMEOUT_MS })
  // Fail-closed: no answer from the validator counts as a violation.
  return reply.isAnswered
    ? parseVerdict(reply.text)
    : { kind: 'violation', reason: `the TDD validator gave no answer (${reply.reason}); retry the write.`, unanswered: true }
}

