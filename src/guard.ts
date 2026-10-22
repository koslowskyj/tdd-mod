// The guard's two decisions, shared by the session's hooks and /tdd-eval:
// which kind of task a prompt starts, and whether a write follows TDD.
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code'
import type { Config } from './config.ts'
import { buildTaskPrompt, parseTaskKind, type TaskKind } from './task.ts'
import { addsExactlyOneTest, buildPrompt, parseVerdict, type Change, type FileContent, type HistoryEvent, type Verdict } from './tdd.ts'

const TIMEOUT_MS = 120_000

export type Pending = { path: string; content: string }

/** A model call; the hooks module passes `$.model.complete` in, since `$` cannot cross an import. */
export type Complete = (request: ModelCompleteRequest, options?: { signal?: AbortSignal }) => Promise<ModelCompleteResult>

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
  /** The judge's tokens over the calls that returned before the decision did; a call cut short may add more later. */
  usage: Usage
}

export type Usage = { input: number; output: number }

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
    return { verdict, opinions: [verdict], fastPath: true, usage: { input: 0, output: 0 } }
  }
  const prompt = buildPrompt(await history(), before, pending, also)
  const usage: Usage = { input: 0, output: 0 }
  const judge: Complete = async (request, options) => {
    const reply = await complete(request, options)
    usage.input += reply.usage?.input_tokens ?? 0
    usage.output += reply.usage?.output_tokens ?? 0
    return reply
  }
  // A single validator call misfires now and then: block only when a second
  // opinion agrees. Still fail-closed: two failed calls block.
  if (config.secondOpinion && config.parallelOpinions) return { ...(await bothOpinions(judge, config, prompt)), fastPath: false, prompt, usage }
  const first = await ask(judge, config, prompt)
  if (first.kind === 'pass' || !config.secondOpinion) return { verdict: first, opinions: [first], fastPath: false, prompt, usage }
  const second = await ask(judge, config, prompt)
  return { verdict: second, opinions: [first, second], fastPath: false, prompt, usage }
}

/**
 * Both opinions asked at once, so a block waits for the slower call rather
 * than for one after the other: the first pass settles it and cuts the other
 * call short; a violation waits for the other opinion.
 */
async function bothOpinions(complete: Complete, config: Config, prompt: string): Promise<Pick<Decision, 'verdict' | 'opinions'>> {
  const stops = [new AbortController(), new AbortController()]
  const asks = stops.map(stop => ask(complete, config, prompt, stop.signal))
  const first = await Promise.race(asks.map((verdict, i) => verdict.then(v => ({ v, other: 1 - i }))))
  if (first.v.kind === 'pass') {
    stops[first.other]?.abort()
    return { verdict: first.v, opinions: [first.v] }
  }
  const second = (await asks[first.other]) ?? first.v
  return { verdict: second, opinions: [first.v, second] }
}

async function ask(complete: Complete, config: Config, prompt: string, signal?: AbortSignal): Promise<Verdict> {
  const reply = await complete({ model: config.judgeModel, prompt, timeoutMs: TIMEOUT_MS }, { signal })
  // Fail-closed: no answer from the validator counts as a violation.
  return reply.isAnswered
    ? parseVerdict(reply.text)
    : { kind: 'violation', reason: `the TDD validator gave no answer (${reply.reason}); retry the write.`, unanswered: true }
}

