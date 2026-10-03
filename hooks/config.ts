// The plugin's settings (plugin.json `userConfig`) as the hooks use them.
import type { PluginOptions } from 'claude-code'

export type Config = {
  enabled: boolean
  judgeModel: string
  classifierModel: string
  classifyTasks: boolean
  fastPath: boolean
  secondOpinion: boolean
  extensions: ReadonlySet<string>
  ignore: readonly RegExp[]
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

/** The engine fills in the manifest's defaults; the fallbacks cover a test or a hand-edited value. */
export function readConfig(options: PluginOptions): Config {
  return {
    enabled: flag(options.enabled, true),
    judgeModel: text(options.judgeModel, 'haiku'),
    classifierModel: text(options.classifierModel, 'haiku'),
    classifyTasks: flag(options.classifyTasks, true),
    fastPath: flag(options.fastPath, true),
    secondOpinion: flag(options.secondOpinion, true),
    extensions: new Set(list(options.extensions).map(e => e.replace(/^\./, '').toLowerCase())),
    ignore: list(options.ignore).map(globToRegExp),
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
