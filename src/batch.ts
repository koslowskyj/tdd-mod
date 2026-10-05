// Writes the model asks for in one response land together: the guard judges
// them on the file state they leave together, not one at a time, so a method
// and its call, or a signature and its caller, are not each denied as
// incomplete. Pure: the hooks module reads the files and the response.
import type { TurnStepToolUse } from 'claude-code'
import { applyEdit, type FileContent } from './tdd.ts'

/** A Write or Edit, as `tool.call` carries it and a model response lists it. */
export type WriteCall = {
  tool: string
  file_path: string
  content?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
}

/** The Write or Edit a response lists, or undefined for any other tool call. */
export function asWriteCall(use: TurnStepToolUse): WriteCall | undefined {
  if (use.name !== 'Write' && use.name !== 'Edit') return undefined
  const input = use.input as Partial<WriteCall> | null
  return typeof input?.file_path === 'string' ? { ...input, tool: use.name, file_path: input.file_path } : undefined
}

export function sameCall(a: WriteCall, b: WriteCall): boolean {
  return (
    a.tool === b.tool && a.file_path === b.file_path && a.content === b.content &&
    a.old_string === b.old_string && a.new_string === b.new_string
  )
}

/**
 * The writes of `uses` the guard judges, in order, when `call` is one of
 * them; else `call` alone.
 */
export function batchFor(uses: readonly TurnStepToolUse[], call: WriteCall, judged: (path: string) => boolean): WriteCall[] {
  const calls = uses.flatMap(use => asWriteCall(use) ?? []).filter(c => judged(c.file_path))
  return calls.some(c => sameCall(c, call)) ? calls : [call]
}

/** The files a batch writes, in the order it first writes them. */
export function filesOf(batch: readonly WriteCall[]): string[] {
  return [...new Set(batch.map(c => c.file_path))]
}

/**
 * The file after the batch's writes to `path` in order, or undefined when one
 * of them cannot apply (the tool then reports it).
 */
export function applyCalls(path: string, before: FileContent, batch: readonly WriteCall[]): string | undefined {
  let content = before.kind === 'present' ? before.content : undefined
  for (const call of batch) {
    if (call.file_path !== path) continue
    if (call.tool === 'Write') content = call.content ?? ''
    else if (content !== undefined) content = applyEdit(content, call.old_string ?? '', call.new_string ?? '', call.replace_all)
    if (content === undefined) return undefined
  }
  return content
}
