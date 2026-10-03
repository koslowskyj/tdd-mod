// The plugin's settings (plugin.json `userConfig`) as the hooks use them.
import type { PluginOptions } from 'claude-code'
import { DEFAULT_TEST_PATTERNS, type TestPatterns } from './tdd.ts'

export type Config = {
  enabled: boolean
  judgeModel: string
  classifierModel: string
  classifyTasks: boolean
  fastPath: boolean
  secondOpinion: boolean
  extensions: ReadonlySet<string>
  ignore: readonly RegExp[]
  testPatterns: TestPatterns
  /** Settings that could not be used, each with what was wrong; the mod shows them at session start. */
  problems: readonly string[]
}

function list(value: unknown): string[] {
  return typeof value === 'string' ? value.split(',').map(s => s.trim()).filter(Boolean) : []
}

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** `**` any run of folders, `*` any part of one name, `?` one character. */
export function globToRegExp(glob: string): RegExp {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] ?? ''
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/'
      source += slash ? '(?:.*/)?' : '.*'
      i += slash ? 2 : 1
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/**
 * The built-in test patterns with the `testPatterns` setting applied: a JSON
 * object from comma-separated extensions to a regex source, e.g.
 * `{"ts,js": "\\bscenario\\(", "py": "^\\s*def should_"}`. Each entry replaces
 * the built-in pattern for its extensions; an empty string removes it.
 */
export function readTestPatterns(value: unknown): { patterns: TestPatterns; problems: string[] } {
  const patterns: Record<string, RegExp> = { ...DEFAULT_TEST_PATTERNS }
  const problems: string[] = []
  if (typeof value !== 'string' || value.trim() === '') return { patterns, problems }
  let entries: unknown
  try {
    entries = JSON.parse(value)
  } catch (error) {
    problems.push(`testPatterns is not valid JSON (${(error as Error).message}); using the built-in patterns`)
    return { patterns, problems }
  }
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    problems.push('testPatterns must be a JSON object like {"ts,js": "regex"}; using the built-in patterns')
    return { patterns, problems }
  }
  for (const [keys, source] of Object.entries(entries)) {
    const extensions = list(keys).map(e => e.replace(/^\./, '').toLowerCase())
    if (typeof source !== 'string') {
      problems.push(`testPatterns["${keys}"] is not a string; kept the built-in pattern`)
      continue
    }
    if (source === '') {
      for (const ext of extensions) delete patterns[ext]
      continue
    }
    try {
      // g: count every declaration; m: ^ and $ match per line.
      const pattern = new RegExp(source, 'gm')
      for (const ext of extensions) patterns[ext] = pattern
    } catch (error) {
      problems.push(`testPatterns["${keys}"] is not a valid regex (${(error as Error).message}); kept the built-in pattern`)
    }
  }
  return { patterns, problems }
}

/** The engine fills in the manifest's defaults; the fallbacks cover a test or a hand-edited value. */
export function readConfig(options: PluginOptions): Config {
  const tests = readTestPatterns(options.testPatterns)
  return {
    enabled: flag(options.enabled, true),
    judgeModel: text(options.judgeModel, 'haiku'),
    classifierModel: text(options.classifierModel, 'haiku'),
    classifyTasks: flag(options.classifyTasks, true),
    fastPath: flag(options.fastPath, true),
    secondOpinion: flag(options.secondOpinion, true),
    extensions: new Set(list(options.extensions).map(e => e.replace(/^\./, '').toLowerCase())),
    ignore: list(options.ignore).map(globToRegExp),
    testPatterns: tests.patterns,
    problems: tests.problems,
  }
}

/** Source files the guard judges: a listed extension, outside every ignored path. */
export function isInScope(path: string, config: Config): boolean {
  const posix = path.replace(/\\/g, '/')
  if (config.ignore.some(glob => glob.test(posix))) return false
  const name = posix.slice(posix.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && config.extensions.has(name.slice(dot + 1).toLowerCase())
}
