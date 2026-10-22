// Finds the source files a Bash command would write, so the guard can send
// those writes through Write/Edit where the TDD check judges them. A
// best-effort shell reading, not a parser: it covers the ways agents write
// files from a shell (redirects, tee, sed -i, cp, dd, inline scripts). A
// move (mv, git mv) keeps the code as it is, so it is no write here.

// `<<EOF`, `<<-EOF`, `<<'EOF'`, `<<"EOF"`, then the body up to the line that ends it.
const HEREDOC = /<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
// `>`, `>>`, `>|`, `2>`, `&>` followed by a target; not `>&2` and not `->`/`=>`.
const REDIRECT = /(?:^|[^-=<>])(?:\d|&)?>[>|]?(?!&)\s*(['"]?)([^\s;|&<>'"()]+)\1/g
// Inline interpreters: Python open(..., 'w'|'a'), write_text/write_bytes, Node writeFile(Sync).
const SCRIPT_WRITE = /open\([^)]*['"][wax]\+?b?['"]|\.write_(?:text|bytes)\(|writeFile(?:Sync)?\(|appendFile(?:Sync)?\(/
const PATH_LITERAL = /['"`]([^'"`\s]+\.\w+)['"`]/g
// A command that runs a script, as `python3 -`, `/usr/bin/node -e`, `uv run python`: not `cat > f <<EOF`.
const INTERPRETER = /(?:^|\/)(?:python[\d.]*|node(?:js)?|deno|bun|tsx|ts-node|ruby|perl|php)$/

/** A simple command's words, where it starts in the shell text, and the directory a `cd` before it left (undefined: unknown). */
type Command = { words: string[]; at: number; dir: string | undefined }

/** `path` as seen from `dir`, `.` and `..` folded; unchanged when it is absolute or the directory is unknown. */
function resolveIn(dir: string | undefined, path: string): string {
  if (dir === undefined || /^[/$~]/.test(path)) return path
  const parts: string[] = []
  for (const part of (dir === '' ? path : `${dir}/${path}`).split('/')) {
    if (part === '.' || (part === '' && parts.length > 0)) continue
    if (part === '..' && parts.length > 0 && parts[parts.length - 1] !== '..') {
      if (parts[parts.length - 1] !== '') parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * The simple commands of `shell` as words, split on unquoted `;`, `|`, `&`
 * and newlines, quotes removed: `sed -i 's/a;b/c/' f` stays one command.
 * Each carries the directory the `cd`s before it left, relative to where the
 * shell started ('' there), so a relative path can be read from where it runs.
 */
function commands(shell: string): Command[] {
  const result: Command[] = []
  let dir: string | undefined = ''
  let words: string[] = []
  let word = ''
  let at = 0
  let quote: string | undefined
  const endWord = () => {
    if (word !== '') words.push(word)
    word = ''
  }
  const endCommand = () => {
    endWord()
    if (words[0]?.startsWith('(')) words[0] = words[0].slice(1)
    if (words.length > 0) result.push({ words, at, dir })
    if (words[0] === 'cd') dir = words.length === 2 && !/^[-$~]/.test(words[1] ?? '') ? resolveIn(dir, words[1] ?? '') : undefined
    words = []
  }
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i] ?? ''
    if (words.length === 0 && word === '') at = i
    if (quote !== undefined) {
      if (c === quote) quote = undefined
      else if (c === '\\' && quote === '"') word += shell[++i] ?? ''
      else word += c
    } else if (c === "'" || c === '"') quote = c
    else if (c === '\\') word += shell[++i] ?? ''
    else if (c === ';' || c === '|' || c === '&' || c === '\n') endCommand()
    else if (c === ' ' || c === '\t') endWord()
    else word += c
  }
  endCommand()
  return result
}

/** The source files `command` would write that `inScope` accepts, deduplicated, in order of appearance. */
export function bashWriteTargets(command: string, inScope: (path: string) => boolean): string[] {
  const targets: string[] = []
  // The command without its heredoc bodies, and each body with where it stood.
  const heredocs: { at: number; body: string }[] = []
  let shell = ''
  let last = 0
  for (const m of command.matchAll(HEREDOC)) {
    shell += command.slice(last, m.index)
    heredocs.push({ at: shell.length, body: m[0] })
    shell += m[0].slice(0, m[0].indexOf('\n'))
    last = m.index + m[0].length
  }
  shell += command.slice(last)

  const parsed = commands(shell)
  const dirAt = (offset: number) => parsed.findLast(c => c.at <= offset)?.dir ?? ''

  for (const m of shell.matchAll(REDIRECT)) targets.push(resolveIn(dirAt(m.index), m[2] ?? ''))

  for (const { words: [cmd, ...args], dir } of parsed) {
    const operands = args.filter(a => !a.startsWith('-'))
    const written: string[] = []
    switch (cmd) {
      case 'tee':
        written.push(...operands)
        break
      case 'sed':
      case 'perl':
        if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) written.push(...operands)
        break
      case 'cp':
      case 'install':
        if (operands.length > 0) written.push(operands[operands.length - 1] ?? '')
        break
      case 'dd':
        written.push(...args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
        break
    }
    targets.push(...written.map(path => resolveIn(dir, path)))
  }

  // An inline script that writes files and names a source file: its target is
  // often a variable, so every source path it names counts, read from where
  // the command that runs it stands. A heredoc fed to `cat > f` is content.
  parsed.forEach(({ words, at, dir }, i) => {
    if (!words.some(w => INTERPRETER.test(w))) return
    const end = parsed[i + 1]?.at ?? Infinity
    const script = [words.join(' '), ...heredocs.filter(h => h.at >= at && h.at < end).map(h => h.body)].join('\n')
    if (!SCRIPT_WRITE.test(script)) return
    for (const m of script.matchAll(PATH_LITERAL)) targets.push(resolveIn(dir, m[1] ?? ''))
  })

  return [...new Set(targets.filter(inScope))]
}
