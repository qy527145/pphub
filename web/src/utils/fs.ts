// 拖拽 / 文件夹选择的统一收集：把 DataTransfer 或 <input webkitdirectory>
// 的结果整理成「零散文件 + 文件夹（含相对路径）」两类，供上层决定
// 逐个发送还是打包成 zip。

import type { ZipEntry } from './zip'

export interface DroppedPayload {
  /** 顶层零散文件。 */
  files: File[]
  /** 顶层文件夹（每个整体打包）。 */
  folders: { name: string; entries: ZipEntry[] }[]
}

interface EntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file(ok: (f: File) => void, err: (e: unknown) => void): void
  createReader(): {
    readEntries(ok: (entries: EntryLike[]) => void, err: (e: unknown) => void): void
  }
}

function entryFile(entry: EntryLike): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

/** readEntries 每批最多 100 条（Chromium），要循环读到空为止。 */
async function readAllEntries(dir: EntryLike): Promise<EntryLike[]> {
  const reader = dir.createReader()
  const out: EntryLike[] = []
  for (;;) {
    const batch = await new Promise<EntryLike[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    )
    if (batch.length === 0) break
    out.push(...batch)
  }
  return out
}

async function walkEntry(entry: EntryLike, prefix: string, sink: ZipEntry[]): Promise<void> {
  if (entry.isFile) {
    try {
      sink.push({ path: prefix + entry.name, file: await entryFile(entry) })
    } catch {
      // 个别文件读不出来（权限/已删除）跳过，不让整个文件夹失败。
    }
    return
  }
  if (entry.isDirectory) {
    const children = await readAllEntries(entry)
    for (const child of children) {
      await walkEntry(child, `${prefix}${entry.name}/`, sink)
    }
  }
}

/**
 * 解析一次 drop。含目录时用 webkitGetAsEntry 递归遍历（Chromium/Firefox/
 * Safari 均支持）；不支持 entry API 的环境退化为纯文件列表（目录会被忽略，
 * 由调用方提示）。注意必须在 drop 事件的同一 tick 里同步取完 items。
 */
export async function collectDropped(dt: DataTransfer): Promise<DroppedPayload> {
  const out: DroppedPayload = { files: [], folders: [] }
  const jobs: Promise<void>[] = []
  let usedEntries = false

  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => unknown }
    ).webkitGetAsEntry?.() as EntryLike | null | undefined
    if (entry?.isDirectory) {
      usedEntries = true
      const folder = { name: entry.name, entries: [] as ZipEntry[] }
      out.folders.push(folder)
      jobs.push(walkEntry(entry, '', folder.entries).then(() => {
        // 遍历出的路径不含顶层目录名（打包为 <name>.zip，包内直接是内容）。
      }))
    } else if (entry?.isFile) {
      usedEntries = true
      jobs.push(
        entryFile(entry).then(
          (f) => void out.files.push(f),
          () => undefined,
        ),
      )
    }
  }

  if (!usedEntries) {
    out.files.push(...dt.files)
  }
  await Promise.all(jobs)
  out.folders = out.folders.filter((f) => f.entries.length > 0)
  return out
}

/**
 * <input webkitdirectory> 的结果按顶层目录分组（webkitRelativePath 首段
 * 即所选文件夹名；包内路径去掉首段，与拖拽遍历的结果保持一致）。
 */
export function groupPickedFolder(files: File[]): DroppedPayload {
  const folders = new Map<string, ZipEntry[]>()
  const loose: File[] = []
  for (const file of files) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath
    const slash = rel?.indexOf('/') ?? -1
    if (rel && slash > 0) {
      const top = rel.slice(0, slash)
      const entries = folders.get(top) ?? []
      entries.push({ path: rel.slice(slash + 1), file })
      folders.set(top, entries)
    } else {
      loose.push(file)
    }
  }
  return {
    files: loose,
    folders: [...folders.entries()].map(([name, entries]) => ({ name, entries })),
  }
}
