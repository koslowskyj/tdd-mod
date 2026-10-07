// Pure logic for the TDD guard: no `$`, so the tests can drive it directly.
// Shapes follow probity's enforceTdd, trimHistory, applyEdit and toVerdict.
import type { SessionMessage } from 'claude-code'
import { DEFAULT_TDD_RULES, PROCESS_INSTRUCTIONS, RESPONSE_SPEC } from './prompt.ts'

export const MAX_EVENTS = 10
export const MAX_CONTENT_CHARS = 6000
// A tool call's input (a Write carries the whole file) and a file shown to the judge.
const MAX_INPUT_CHARS = 1500
const MAX_FILE_CHARS = 20_000
const CONTEXT_CHARS = 2000

export type FileContent =
  | { kind: 'present'; content: string }
  | { kind: 'absent' }
  | { kind: 'unknown' }

export type HistoryEvent =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; tool: string; input: unknown; output: string; isError?: true }

/** The latest test command the agent ran, what it printed, and whether it failed. */
export type TestRun = { command: string; output: string; red: boolean }

// A command that runs tests: a runner's test subcommand, a test runner by name
// (not a file named after one, like jest.config.js), or a Maven/Gradle build.
const TEST_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun|deno|go|cargo|dotnet|mix|swift|make|plugin)\s+(?:run\s+)?test\b`,
    String.raw`\b(?:vitest|jest|pytest|mocha|rspec|phpunit|unittest)(?![\w./-])`,
    String.raw`\b(?:mvnw?|gradlew?)\b.*\b(?:test|verify|install|check|build)\b`,
  ].join('|'),
)
// What a failing run prints, also when a pipe (`| tail`) hid its exit code.
const RED_OUTPUT =
  /^Exit code [1-9]|\bFAIL|\b[1-9]\d* (?:fail|failed|failing|failures?|errors?)\b|\b(?:Failures|Errors): [1-9]|^# fail [1-9]|^not ok \d|\bAssertionError\b|\bpanicked\b/m

export function lastTestRun(events: readonly HistoryEvent[]): TestRun | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.kind !== 'tool' || event.tool !== 'Bash') continue
    const command = (event.input as { command?: unknown } | null)?.command
    if (typeof command !== 'string' || !TEST_COMMAND.test(command)) continue
    return { command, output: event.output, red: event.isError === true || RED_OUTPUT.test(event.output) }
  }
  return undefined
}

/**
 * What a verdict rests on besides the write: the last test run and the person's
 * latest prompt. A retry of the same write with the same evidence gets the same
 * verdict; a new test run or an override is new evidence.
 */
export function evidenceOf(events: readonly HistoryEvent[]): string {
  const prompt = events.findLast(event => event.kind === 'prompt')
  return JSON.stringify([lastTestRun(events) ?? null, prompt?.kind === 'prompt' ? prompt.text : null])
}

export type Verdict = { kind: 'pass' | 'violation'; reason: string }

// Test declarations per language, by extension. A regex stand-in for
// probity's ast-grep matchers: the module has no Node to run ast-grep.
// The `testPatterns` setting overrides or extends them per extension.
export type TestPatterns = Readonly<Record<string, RegExp>>

const JS_TEST = /\b(?:it|test)(?:\.(?:only|skip|todo|concurrent))?\s*\(\s*['"`]/g
export const DEFAULT_TEST_PATTERNS: TestPatterns = {
  ts: JS_TEST, tsx: JS_TEST, mts: JS_TEST, cts: JS_TEST,
  js: JS_TEST, jsx: JS_TEST, mjs: JS_TEST, cjs: JS_TEST,
  py: /^[ \t]*(?:async[ \t]+)?def[ \t]+test\w*[ \t]*\(/gm,
  go: /^func[ \t]+Test\w*[ \t]*\(/gm,
  java: /@Test\b/g, kt: /@Test\b/g, kts: /@Test\b/g,
  rs: /#\[(?:tokio::)?test\]/g,
  rb: /^[ \t]*(?:it[ \t]+['"]|def[ \t]+test_)/gm,
  cs: /\[(?:Fact|Theory|Test|TestMethod)\b/g,
}

function countTests(pattern: RegExp, text: string): number {
  return text.match(pattern)?.length ?? 0
}

/**
 * The fast path: a write that adds exactly one test declaration is the red
 * step itself and passes without a model call. Undefined content before the
 * write, or a language without a pattern, never qualifies.
 */
export function addsExactlyOneTest(
  path: string,
  before: FileContent,
  after: string,
  patterns: TestPatterns = DEFAULT_TEST_PATTERNS,
): boolean {
  if (before.kind === 'unknown') return false
  const pattern = patterns[path.slice(path.lastIndexOf('.') + 1).toLowerCase()]
  if (pattern === undefined) return false
  const beforeText = before.kind === 'present' ? before.content : ''
  return countTests(pattern, after) - countTests(pattern, beforeText) === 1
}

/**
 * The file as the Edit leaves it, or undefined when the edit cannot apply
 * (the Edit tool itself then reports the miss).
 */
export function applyEdit(
  current: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): string | undefined {
  const occurrences = current.split(oldString).length - 1
  if (oldString === '' || occurrences === 0) return undefined
  if (occurrences > 1 && !replaceAll) return undefined
  // A replacer keeps $&, $$ and friends in newString literal.
  const replacer = () => newString
  return replaceAll
    ? current.replaceAll(oldString, replacer)
    : current.replace(oldString, replacer)
}

/** Prompts and answered tool calls, oldest first, as the validator reads them. */
export function toHistory(messages: readonly SessionMessage[]): HistoryEvent[] {
  const events: HistoryEvent[] = []
  for (const message of messages) {
    if (message.role === 'user' && message.text.trim() !== '') {
      events.push({ kind: 'prompt', text: message.text })
    }
    for (const use of message.toolUses) {
      if (use.text === undefined) continue
      events.push({ kind: 'tool', tool: use.tool, input: use.input, output: use.text, ...(use.isError && { isError: true }) })
    }
  }
  return events
}

export function trimHistory(
  events: readonly HistoryEvent[],
  maxEvents = MAX_EVENTS,
  maxContentChars = MAX_CONTENT_CHARS,
): HistoryEvent[] {
  return events.slice(-maxEvents).map(event =>
    event.kind === 'prompt'
      ? { ...event, text: clip(event.text, maxContentChars) }
      : { ...event, output: clip(event.output, maxContentChars) },
  )
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  const omitted = s.length - 2 * half
  return `${s.slice(0, half)}\n[${omitted} more characters truncated]\n${s.slice(s.length - half)}`
}

function formatEvent(event: HistoryEvent): string {
  if (event.kind === 'prompt') return `User: ${event.text}`
  const input = typeof event.input === 'string' ? event.input : JSON.stringify(event.input)
  return `${event.tool}(${clip(input, MAX_INPUT_CHARS)}) → ${event.output}`
}

/**
 * A file's before and after, cut for the judge: the changed region with some
 * unchanged characters around it, each side at most MAX_FILE_CHARS. A file
 * within the cap is left whole.
 */
function windowChange(before: FileContent, after: string): { before: FileContent; content: string } {
  if (before.kind !== 'present') return { before, content: clip(after, MAX_FILE_CHARS) }
  const old = before.content
  if (old.length <= MAX_FILE_CHARS && after.length <= MAX_FILE_CHARS) return { before, content: after }
  const shortest = Math.min(old.length, after.length)
  let head = 0
  while (head < shortest && old[head] === after[head]) head++
  let tail = 0
  while (tail < shortest - head && old[old.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  const skipHead = Math.max(0, head - CONTEXT_CHARS)
  const skipTail = Math.max(0, tail - CONTEXT_CHARS)
  const note = (n: number) => `[${n} unchanged characters omitted]`
  const view = (text: string) =>
    clip(
      `${skipHead > 0 ? `${note(skipHead)}\n` : ''}${text.slice(skipHead, text.length - skipTail)}${skipTail > 0 ? `\n${note(skipTail)}` : ''}`,
      MAX_FILE_CHARS,
    )
  return { before: { kind: 'present', content: view(old) }, content: view(after) }
}

function formatBefore(before: FileContent): string {
  switch (before.kind) {
    case 'present':
      return before.content
    case 'absent':
      return '(file does not exist)'
    case 'unknown':
      return '(current file content unavailable)'
  }
}

// Under green the judge denied an unused field's removal and a helper
// extraction; say outright that such changes are the refactor step.
const GREEN_REFACTOR =
  'The tests are green, so this may be the refactor step. A change that keeps ' +
  'behaviour passes without a new failing test: extracting a helper from code ' +
  'that already exists, inlining, renaming, restructuring, or removing unused ' +
  'code (a field, an import, a function nothing calls). Block it only when it ' +
  'adds behaviour that no test drove.'

// Left unsaid, the judge assumed a test it could not see and passed a stub
// written before any test (/tdd-eval "stub before any test").
const NO_TEST_RUN = '## Last test run\n\nNo test has run in this session yet, so no failure has been observed.'

function formatTestRun(run: TestRun): string {
  const result = run.red ? 'red: a test failed' : 'green: every test passed'
  const output = `## Last test run\n\n\`${clip(run.command, MAX_INPUT_CHARS)}\` was ${result}. Its output:\n\n${clip(run.output, MAX_CONTENT_CHARS)}`
  return run.red ? output : `${output}\n\n${GREEN_REFACTOR}`
}

/** The judge's prompt; `history` is the whole session, of which it shows the recent part and the last test run. */
export function buildPrompt(
  history: readonly HistoryEvent[],
  before: FileContent,
  action: { path: string; content: string },
  also: readonly Change[] = [],
): string {
  const sections = [PROCESS_INSTRUCTIONS, DEFAULT_TDD_RULES]
  const recent = trimHistory(history)
  if (recent.length > 0) {
    sections.push(`## Recent session\n\n${recent.map(formatEvent).join('\n')}`)
  }
  const run = lastTestRun(history)
  sections.push(run ? formatTestRun(run) : NO_TEST_RUN)
  const main = { ...action, ...windowChange(before, action.content) }
  if (also.length === 0) {
    sections.push(`## Current file content\n\n${formatBefore(main.before)}`)
    sections.push(`## Pending action\n\nFile: ${main.path}\n\n${main.content}`)
  } else {
    const changes = [main, ...also.map(c => ({ ...c, ...windowChange(c.before, c.content) }))]
    sections.push(`## Current file content\n\n${changes.map(c => `File: ${c.path}\n\n${formatBefore(c.before)}`).join('\n\n')}`)
    sections.push(
      `## Pending action\n\n${BATCH_NOTE}\n\n${changes.map(c => `File: ${c.path}\n\n${c.content}`).join('\n\n')}`,
    )
  }
  sections.push(RESPONSE_SPEC)
  return sections.join('\n\n')
}

/** One file a write of a batch changes: as it is, and as the batch leaves it. */
export type Change = { path: string; before: FileContent; content: string }

const BATCH_NOTE =
  'These writes were sent together in one response and land together: judge them as one change, ' +
  'on the files they leave together. The verdict applies to all of them.'

/** Fail-closed: anything but a well-formed verdict is a violation. */
export function parseVerdict(text: string): Verdict {
  const parsed = safeParse(text.trim()) ?? safeParse(stripFence(text)) ?? findEmbeddedObject(text)
  if (
    typeof parsed === 'object' && parsed !== null &&
    'kind' in parsed && (parsed.kind === 'pass' || parsed.kind === 'violation') &&
    'reason' in parsed && typeof parsed.reason === 'string'
  ) {
    return { kind: parsed.kind, reason: parsed.reason }
  }
  return {
    kind: 'violation',
    reason: `could not parse verdict from validator output: ${text.slice(0, 500)}`,
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function stripFence(text: string): string {
  return text.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim()
}

/** The last balanced `{...}` that parses: models sometimes reason before answering. */
function findEmbeddedObject(text: string): unknown {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    const span = scanBalanced(text, start)
    const parsed = span === undefined ? undefined : safeParse(span)
    if (parsed !== undefined) return parsed
    if (start === 0) break
  }
  return undefined
}

function scanBalanced(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (escape) escape = false
    else if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return undefined
}
