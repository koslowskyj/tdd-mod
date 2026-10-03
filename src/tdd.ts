// Pure logic for the TDD guard: no `$`, so the tests can drive it directly.
// Shapes follow probity's enforceTdd, trimHistory, applyEdit and toVerdict.
import type { SessionMessage } from 'claude-code'
import { DEFAULT_TDD_RULES, PROCESS_INSTRUCTIONS, RESPONSE_SPEC } from './prompt.ts'

export const MAX_EVENTS = 10
export const MAX_CONTENT_CHARS = 6000

export type FileContent =
  | { kind: 'present'; content: string }
  | { kind: 'absent' }
  | { kind: 'unknown' }

export type HistoryEvent =
  | { kind: 'prompt'; text: string }
  | { kind: 'tool'; tool: string; input: unknown; output: string }

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
      events.push({ kind: 'tool', tool: use.tool, input: use.input, output: use.text })
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
  return `${event.tool}(${input}) → ${event.output}`
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

export function buildPrompt(
  history: readonly HistoryEvent[],
  before: FileContent,
  action: { path: string; content: string },
): string {
  const sections = [PROCESS_INSTRUCTIONS, DEFAULT_TDD_RULES]
  if (history.length > 0) {
    sections.push(`## Recent session\n\n${history.map(formatEvent).join('\n')}`)
  }
  sections.push(`## Current file content\n\n${formatBefore(before)}`)
  sections.push(`## Pending action\n\nFile: ${action.path}\n\n${action.content}`)
  sections.push(RESPONSE_SPEC)
  return sections.join('\n\n')
}

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
