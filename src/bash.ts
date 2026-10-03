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

/**
 * The simple commands of `shell` as words, split on unquoted `;`, `|`, `&`
 * and newlines, quotes removed: `sed -i 's/a;b/c/' f` stays one command.
 */
function commands(shell: string): string[][] {
  const result: string[][] = []
  let words: string[] = []
  let word = ''
  let quote: string | undefined
  const endWord = () => {
    if (word !== '') words.push(word)
    word = ''
  }
  const endCommand = () => {
    endWord()
    if (words.length > 0) result.push(words)
    words = []
  }
  for (let i = 0; i < shell.length; i++) {
    const c = shell[i] ?? ''
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
  const shell = command.replace(HEREDOC, (match, _q, _tag) => match.slice(0, match.indexOf('\n')))

  for (const m of shell.matchAll(REDIRECT)) targets.push(m[2] ?? '')

  for (const [cmd, ...args] of commands(shell)) {
    const operands = args.filter(a => !a.startsWith('-'))
    switch (cmd) {
      case 'tee':
        targets.push(...operands)
        break
      case 'sed':
      case 'perl':
        if (args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) targets.push(...operands)
        break
      case 'cp':
      case 'install':
        if (operands.length > 0) targets.push(operands[operands.length - 1] ?? '')
        break
      case 'dd':
        targets.push(...args.filter(a => a.startsWith('of=')).map(a => a.slice(3)))
        break
    }
  }

  // An inline script that writes files and names a source file: its target is
  // often a variable, so every source path it names counts.
  if (SCRIPT_WRITE.test(command)) {
    for (const m of command.matchAll(PATH_LITERAL)) targets.push(m[1] ?? '')
  }

  return [...new Set(targets.filter(inScope))]
}
