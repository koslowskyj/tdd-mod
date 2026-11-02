/** Whether a path exists; the hooks pass `$.fs.exists` in. */
export type Exists = (path: string) => Promise<boolean>

/** Each folder's repository root, or undefined for none, kept for the session. */
export type RootCache = Map<string, string | undefined>

/**
 * The root of the project `path` belongs to, for a session launched in
 * `root`: a relative path, or an absolute one below the root, is the
 * session's; any other lives in the nearest folder above it holding `.git`
 * (a folder, or a file in a worktree or submodule), so a sibling repository
 * is a project too. A file in no repository, a scratch script in /tmp, has
 * none. With no root known, every path is the session's.
 *
 * Each folder's answer goes into `cache`, so the walk up the tree runs once
 * per folder, not on every write: the hook's budget is 10 s.
 */
export async function projectRootOf(exists: Exists, path: string, root: string, cache: RootCache): Promise<string | undefined> {
  const base = root.replace(/\\/g, '/').replace(/\/$/, '')
  const posix = path.replace(/\\/g, '/')
  if (base === '' || !posix.startsWith('/') || posix.startsWith(`${base}/`)) return base
  return repositoryOf(exists, posix.slice(0, posix.lastIndexOf('/')), cache)
}

/** The nearest folder from `dir` up that holds `.git`; undefined at the top. */
async function repositoryOf(exists: Exists, dir: string, cache: RootCache): Promise<string | undefined> {
  if (dir === '') return undefined
  if (cache.has(dir)) return cache.get(dir)
  const own = (await exists(`${dir}/.git`).catch(() => false)) ? dir : await repositoryOf(exists, dir.slice(0, dir.lastIndexOf('/')), cache)
  cache.set(dir, own)
  return own
}
