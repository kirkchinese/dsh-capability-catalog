/**
 * Skills found in directories the Harness does not scan by itself.
 *
 * The Harness skill catalog covers its own directories. Claude Code keeps its skills in
 * `~/.claude/skills`, and a project may keep some in `.dsh/skills`; this module reads those
 * folders directly so the same instructions reach the model here. A skill found this way is
 * indexed and loaded exactly like a native one, and a native skill of the same name wins.
 * @module
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillDefinitionLike } from './types.js'

/** A skill discovered in an extra directory. */
export interface ExtraSkill {
  readonly name: string
  readonly description: string
  /** Directory holding `SKILL.md`; relative references in the skill resolve against it. */
  readonly directory: string
  /** Absolute path of the skill file. */
  readonly file: string
  readonly modifiedMs: number
}

/** Result of scanning the extra directories. */
export interface SkillDirScan {
  readonly skills: ReadonlyMap<string, ExtraSkill>
  readonly problems: readonly string[]
}

/** Front matter data plus the instructions that follow it. */
export interface ParsedSkillFile {
  readonly data: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * Read a leading YAML front matter block of flat `key: value` lines.
 *
 * Only the subset a skill needs is understood: one-line scalars, optionally quoted. Anything
 * more elaborate is left in the body rather than guessed at.
 * @param text - whole skill file.
 */
export function parseSkillFile(text: string): ParsedSkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/u.exec(text)
  if (match === null) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of (match[1] ?? '').split(/\r?\n/u)) {
    const pair = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/u.exec(line)
    if (pair === null) continue
    let value = (pair[2] ?? '').trim()
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1)
    data[pair[1]!] = value
  }
  return { data, body: text.slice(match[0].length).trim() }
}

/**
 * Scan directories for `<dir>/<skill>/SKILL.md`.
 *
 * A missing directory is normal and silent; an unreadable file is reported. The first directory
 * that provides a name keeps it, so an earlier entry in the list has priority.
 * @param dirs - absolute directories, scanned in order.
 */
export async function scanSkillDirs(dirs: readonly string[]): Promise<SkillDirScan> {
  const skills = new Map<string, ExtraSkill>()
  const problems: string[] = []
  for (const dir of dirs) {
    if (dir.trim() === '') continue
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      if ((error as { code?: string }).code !== 'ENOENT') problems.push(`${dir}: ${reasonOf(error)}`)
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const directory = join(dir, entry.name)
      const file = join(directory, 'SKILL.md')
      let info
      try {
        info = await stat(file)
      } catch {
        continue // Not a skill folder.
      }
      if (!info.isFile()) continue
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch (error) {
        problems.push(`${file}: ${reasonOf(error)}`)
        continue
      }
      const { data } = parseSkillFile(text)
      const name = (data.name ?? entry.name).trim()
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(name)) {
        problems.push(`${file}: name "${name}" is not usable as a skill name`)
        continue
      }
      const earlier = skills.get(name)
      if (earlier !== undefined) {
        problems.push(`${file}: duplicate skill name "${name}", kept ${earlier.file}`)
        continue
      }
      skills.set(name, { name, description: (data.description ?? '').trim(), directory, file, modifiedMs: info.mtimeMs })
    }
  }
  return { skills, problems }
}

/**
 * Load one discovered skill as the Harness would describe it.
 * @param skill - entry from {@link scanSkillDirs}.
 * @returns the definition, or undefined when the file disappeared or cannot be read.
 */
export async function readSkillFile(skill: ExtraSkill): Promise<SkillDefinitionLike | undefined> {
  try {
    const { body } = parseSkillFile(await readFile(skill.file, 'utf8'))
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'skills',
      provider: 'filesystem',
      resourceBase: { kind: 'directory', path: skill.directory },
      content: body,
    }
  } catch {
    return undefined
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
