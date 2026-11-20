// Pure logic for the TDD guard: no `$`, so the tests can drive it directly.
// Shapes follow probity's enforceTdd, trimHistory, applyEdit and toVerdict.
import type { SessionMessage } from 'claude-code'
import { CHECK_DRIVEN_CHANGES, DEFAULT_TDD_RULES, NO_STUB_STEP, OUTSIDE_IN_TESTS, PROCESS_INSTRUCTIONS, RESPONSE_SPEC } from './prompt.ts'

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

/**
 * The latest test command the agent ran, what it printed, and whether it failed;
 * `running` when it went to the background and no read shows it finished yet;
 * `check` when it is a lint or static-analysis check that failed, not a test run.
 */
export type TestRun = { command: string; output: string; red: boolean; running?: true; check?: true }

// A command that runs tests: a runner's test subcommand, a test runner by name
// (not a file named after one, like jest.config.js), or a Maven/Gradle build.
// A Maven phase stands alone: `pmd:check` is a lint goal and `test-compile`
// runs no test; a Gradle task may carry a project path (`:app:test`).
const TEST_COMMAND = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun|deno|go|cargo|dotnet|mix|swift|make|plugin)\s+(?:run\s+)?test\b`,
    String.raw`\b(?:vitest|jest|pytest|mocha|rspec|phpunit|unittest)(?![\w./-])`,
    String.raw`\bplaywright\s+test\b`,
    String.raw`\bmvnw?\b.*(?<![\w:-])(?:test|verify|install|package)(?![\w:-])`,
    String.raw`\bgradlew?\b.*\b(?:test|check|build)\b`,
  ].join('|'),
)
// A build told to skip its tests runs none.
const SKIPS_TESTS = /-DskipTests\b|-Dmaven\.test\.skip=true\b|\s-x\s+(?::?\w+:)*test\b/

function isTestCommand(command: string): boolean {
  return TEST_COMMAND.test(command) && !SKIPS_TESTS.test(command)
}
// What a failing run prints, also when a pipe (`| tail`) hid its exit code.
// An exit code the agent echoes after a run (`echo rc=$?`) counts too.
const RED_OUTPUT =
  /^Exit code [1-9]|\b(?:rc|exit|status)=[1-9]|\bFAIL|\b[1-9]\d* (?:fail|failed|failing|failures?|errors?)\b|\b(?:Failures|Errors): [1-9]|^# fail [1-9]|^not ok \d|\bAssertionError\b|\bpanicked\b/m
// The file a command sends its output to: `> f`, `>> f`, `2>&1 > f`, `&> f`, `| tee f`.
const LOG_TARGET = /(?:(?:^|[^-=<>&\d])(?:\d|&)?>>?(?!&)|\btee(?:\s+-a)?)\s*(['"]?)([^\s;|&<>'"()]+)\1/g

// A lint, type or static-analysis check: a failing one is a red step too (a passing one says nothing of the tests).
// A tool counts where it runs: at the start of a command, or after a runner such as `npx`; not named in `grep eslint`.
// After a separator or a newline, variables (`CI=1`), a runner with its options (`npx --yes`) or a path.
const CHECK_COMMAND =
  /(?:^|[;&|(\n])\s*(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm\s+exec|pnpm|yarn|uv\s+run|poetry\s+run|python3?\s+-m|cargo)\s+(?:-[\w-]+\s+)*)?(?:\S*\/)?(eslint|oxlint|biome|tsc|ruff|mypy|pylint|flake8|golangci-lint|clippy)\b|\bmvnw?\b[^;&|\n]*\b(pmd|spotbugs|checkstyle):\w+|\bgradlew?\b[^;&|\n]*\b(pmd|spotbugs|checkstyle)\w*/

/** The check tool `command` runs, lower-cased; undefined when it runs none. */
function checkToolOf(command: string): string | undefined {
  const m = CHECK_COMMAND.exec(command)
  return (m?.[1] ?? m?.[2] ?? m?.[3])?.toLowerCase()
}
// What a check that found something prints: Maven/Gradle failures, ESLint's problems, tsc's `error TS`,
// flake8/pylint's `a.py:1:1: F401`, golangci-lint's issues, clippy's `error:`, a rule violation count.
const CHECK_FAILED =
  /\bBUILD FAIL(?:URE|ED)\b|\[ERROR\]|\b[1-9]\d* (?:problems?|errors?|violations?|issues?)\b|\berror TS\d+|: error:|:\d+:\d+: [A-Z]+\d{3,4}\b|^error(?:\[\w+\])?:|rule violations were found/m
// What a finished passing run prints: a run in the background is finished once a read shows this or a failure.
// Only what a runner prints once at the end counts: Maven/Gradle's BUILD SUCCESS(FUL), Playwright's
// `4 passed (3s)`, Vitest/Jest's `Tests: 4 passed`, pytest's `== 4 passed in`, PHPUnit/unittest's OK,
// RSpec's `4 examples, 0 failures`, TAP's `# pass`. Not a test class's `Tests run: …` line, Go's
// per-package `ok`, .NET's per-project `Passed!` or an umbrella app's `N tests, 0 failures`: those
// come while the run goes on; such a run ends at the harness's completion notice.
const PASS_SUMMARY =
  /\bBUILD SUCCESS(?:FUL)?\b|^\s*[1-9]\d* passed \(|^\s*Tests:?\s+[1-9]\d* passed|=+ [1-9]\d* passed\b|^OK(?: \([1-9]\d* tests?[,)]|$)|\b[1-9]\d* examples, 0 failures\b|^# pass [1-9]/m
// The notice the harness sends when a command in the background ends.
const COMPLETION_NOTICE = /<output-file>([^<]+)<\/output-file>[\s\S]*?<status>(completed|failed|killed)<\/status>/

// What a command refused before it ran answers: this mod's own shell-write guard, another hook, the permission check.
const REFUSED_OUTPUT = /^\s*(?:<tool_use_error>)?\s*(?:tdd-mod:|PreToolUse:\w+ hook (?:error|blocked)|Permission to use \w+[^\n]* denied|The user doesn't want to proceed)/

/** Whether a tool call ran: a refused one never did, whatever its command says. */
function didRun(event: HistoryEvent): boolean {
  return !(event.kind === 'tool' && event.isError === true && REFUSED_OUTPUT.test(event.output))
}

// What a Bash call run in the background answers: where its output goes.
const BACKGROUND_OUTPUT = /Output is being written to: (\S+?)\.?(?=\s|$)/

/** The file a Read call reads; undefined for any other tool. */
function readPathOf(event: HistoryEvent): string | undefined {
  if (event.kind !== 'tool' || event.tool !== 'Read') return undefined
  const path = (event.input as { file_path?: unknown } | null)?.file_path
  return typeof path === 'string' ? path : undefined
}

function commandOf(event: HistoryEvent | undefined): string | undefined {
  if (event?.kind !== 'tool' || event.tool !== 'Bash') return undefined
  const command = (event.input as { command?: unknown } | null)?.command
  return typeof command === 'string' ? command : undefined
}

/**
 * The latest test run, or the latest failing lint or static-analysis check
 * when that came later. A tool call a hook or the permission check refused
 * never ran and is skipped. A run whose output went to a log (`mvn test > t.log;
 * echo rc=$?`) is read with the later commands that read that log; a run sent
 * to the background, with the later Bash or Read calls on its output file,
 * and it is running until one of them shows it failed or passed.
 */
export function lastTestRun(events: readonly HistoryEvent[]): TestRun | undefined {
  const passedChecks = new Set<string>()
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const command = commandOf(event)
    if (event?.kind !== 'tool' || command === undefined || !didRun(event)) continue
    const isTest = isTestCommand(command)
    const tool = isTest ? undefined : checkToolOf(command)
    if (!isTest && (tool === undefined || passedChecks.has(tool))) continue
    const backgroundLog = BACKGROUND_OUTPUT.exec(event.output)?.[1]
    const logs = [
      ...[...command.matchAll(LOG_TARGET)].map(m => m[2] ?? '').filter(log => log !== '' && !log.startsWith('/dev/')),
      ...(backgroundLog === undefined ? [] : [backgroundLog]),
    ]
    const reads = events.slice(i + 1).flatMap(later => {
      const readTarget = commandOf(later) ?? readPathOf(later)
      return later.kind === 'tool' && didRun(later) && readTarget !== undefined && logs.some(log => readTarget.includes(log))
        ? [`$ ${readTarget}\n${later.output}`]
        : []
    })
    // The harness's notice that the command in the background ended, and how; each notice of a prompt on its own.
    const status = events.slice(i + 1).flatMap(later =>
      later.kind !== 'prompt'
        ? []
        : [...later.text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)].flatMap(([block]) => {
            const notice = COMPLETION_NOTICE.exec(block)
            return notice && notice[1]?.trim() === backgroundLog ? [notice[2]] : []
          }),
    )[0]
    const output = [event.output, ...reads].join('\n')
    const red = event.isError === true || RED_OUTPUT.test(output) || status === 'failed'
    if (tool !== undefined) {
      // Only findings make it red: a check that crashed or is not installed ran no rule, and passed none.
      if (CHECK_FAILED.test(output)) return { command, output, red: true, check: true }
      // A check that passed says nothing of the tests, and clears the earlier failures of the same tool.
      if (!red) passedChecks.add(tool)
      continue
    }
    // A run killed before it ended has no result: it stays running.
    const ended = status === 'completed' || status === 'failed'
    if (backgroundLog !== undefined && !red && !ended && !PASS_SUMMARY.test(reads.join('\n'))) return { command, output, red: false, running: true }
    return { command, output, red }
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

// A red that reached an assertion, not a compile or import error. A UI test's
// wait that timed out (Playwright, Awaitility) is its assertion failing, and
// Surefire counts failed assertions as Failures, thrown errors as Errors.
const ASSERTION_FAILED =
  /\bAssertion(?:Failed)?Error\b|\bComparisonFailure\b|\bExpected:|\bexpected\b[^\n]*\b(?:received|but (?:was|got)|to (?:be|equal))\b|\bassert(?:ion)? failed\b|\bExpecting (?:actual|value)\b|\bTimeout \d+ms exceeded\b|\bTimeoutError\b|\bConditionTimeoutException\b|\bFailures: [1-9]/i

/**
 * What a blocked agent does next, from the last test run: one fixed line, so
 * a block does not end in a retry of the same write.
 */
export function nextStep(run: TestRun | undefined, stubFirst = true): string {
  return `${stepAfter(run, stubFirst)} The same write is blocked again until a new test run.`
}

function stepAfter(run: TestRun | undefined, stubFirst: boolean): string {
  if (!run) return 'Next: write a failing test for this change and run it, then make the smallest change that passes it.'
  if (run.running) return 'Next: read the output of the test run in the background, so its result is known, then write the change it calls for.'
  if (run.check) return 'Next: change only what the failing check asks for, keeping behaviour, and rerun the check.'
  if (!run.red) return 'Next: write and run a failing test for the new behaviour first; a refactor under green must not change behaviour.'
  if (ASSERTION_FAILED.test(run.output)) return 'Next: change only what the failing assertion needs, or run the test this change is for.'
  if (stubFirst) return 'Next: write only a placeholder stub that lets the test compile or import, and rerun the tests to see its assertion fail.'
  return 'Next: change only what the failing test needs, or run the test this change is for.'
}

/**
 * `unanswered`: a violation only because the validator gave no answer, so it is no evidence to cache.
 * `next`: what to do after a block, from the last test run.
 */
export type Verdict = { kind: 'pass' | 'violation'; reason: string; unanswered?: true; next?: string }

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
  'code (a field, an import, a function nothing calls). So does a change no ' +
  'unit test can observe and that adds no branching logic: styling (CSS, a ' +
  'theme rule), a log line, or registering a class with a framework (reflection ' +
  'or native-image config, a DI binding). Block it only when it adds behaviour ' +
  'that no test drove.'

// Left unsaid, the judge assumed a test it could not see and passed a stub
// written before any test (/tdd-eval "stub before any test").
const NO_TEST_RUN = '## Last test run\n\nNo test has run in this session yet, so no failure has been observed.'

function formatTestRun(run: TestRun): string {
  if (run.running) {
    return `## Last test run\n\n\`${clip(run.command, MAX_INPUT_CHARS)}\` is still running in the background; whether it is red or green is not known yet.`
  }
  const result = run.check ? 'red: a check failed (lint or static analysis, not a test)' : run.red ? 'red: a test failed' : 'green: every test passed'
  const output = `## Last test run\n\n\`${clip(run.command, MAX_INPUT_CHARS)}\` was ${result}. Its output:\n\n${clip(run.output, MAX_CONTENT_CHARS)}`
  return run.red ? output : `${output}\n\n${GREEN_REFACTOR}`
}

/** The judge's prompt; `history` is the whole session, of which it shows the recent part and the last test run. */
export function buildPrompt(
  history: readonly HistoryEvent[],
  before: FileContent,
  action: { path: string; content: string },
  also: readonly Change[] = [],
  options: { stubFirst?: boolean } = {},
): string {
  const sections = [PROCESS_INSTRUCTIONS, DEFAULT_TDD_RULES, CHECK_DRIVEN_CHANGES, OUTSIDE_IN_TESTS]
  if (options.stubFirst === false) sections.push(NO_STUB_STEP)
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
  const loose = LOOSE_VERDICT.exec(stripFence(text))
  if (loose?.[1] === 'pass' || loose?.[1] === 'violation') return { kind: loose[1], reason: loose[2] ?? '' }
  return {
    kind: 'violation',
    reason: `could not parse verdict from validator output: ${text.slice(0, 500)}`,
  }
}

// A verdict that is no valid JSON: the judge quoted code in its reason without
// escaping the quotes (`v-if="x"`), or its reply was cut off. The kind it
// named still stands; the reason runs to the closing `"}` or the end.
const LOOSE_VERDICT = /^\{\s*"kind"\s*:\s*"(pass|violation)"\s*,\s*"reason"\s*:\s*"([\s\S]*?)(?:"\s*\}[\s\S]*)?$/

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
