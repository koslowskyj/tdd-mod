// Which kind of task a prompt asks for. The guard judges writes only while
// the task is coding; for anything else (moving or renaming code, docs,
// config, questions) nothing is blocked.

export type TaskKind = 'coding' | 'other'

const MAX_PROMPT_CHARS = 4000

/** The classifier prompt; `previous` decides a follow-up like "continue". */
export function buildTaskPrompt(prompt: string, previous: TaskKind): string {
  const text = prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}\n[truncated]` : prompt
  return `Classify a request a developer gave a coding agent. Answer with exactly one label:

coding: adds, changes or fixes behaviour — a feature, a bug fix, a kata or exercise
  step, implementing something, writing tests for new behaviour.
other: anything else — moving or renaming files, classes or functions, extracting or
  inlining code, reorganising folders, formatting, dependencies, config, docs,
  questions, reviews, git work.

When a request mixes coding with other work, answer coding.
The previous request was labelled ${previous}. A follow-up that names no task of its
own gets the previous label: ${previous}. Follow-ups are "continue", "go on", "retry",
"yes" and answers to the agent's question.

Request:
<request>
${text}
</request>

Label:`
}

// Overriding the guard ("let it through", "I'm overriding the TDD check") is
// about the task at hand, not a new one; haiku labels it other, which would
// switch the guard off until the next coding request.
const GUARD_OVERRIDE = /\boverrid(?:e|es|ing)\b|\blet (?:it|this|that|the \w+) through\b|\b(?:tdd|guard)\b/i

/** Whether `prompt` speaks to the guard, so the task kind stays as it is. */
export function isGuardInstruction(prompt: string): boolean {
  return GUARD_OVERRIDE.test(prompt)
}

/** The kind the reply names; an unclear reply counts as coding, so the guard stays on when in doubt. */
export function parseTaskKind(reply: string): TaskKind {
  const match = /\b(coding|other)\b/i.exec(reply)
  return match?.[1]?.toLowerCase() === 'other' ? 'other' : 'coding'
}
