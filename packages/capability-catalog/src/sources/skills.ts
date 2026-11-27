/**
 * Skill source: indexes the Harness skill catalog by family and name only.
 *
 * The native catalog repeats every description (up to 500 characters each) in every
 * session and re-appends the whole list on any change. This source keeps names in the
 * standing index and leaves descriptions to search. Skills found in extra directories
 * (see `skill-dirs.ts`) are merged in, so a folder such as `~/.claude/skills` reaches the
 * model without being copied into the Harness catalog.
 * @module
 */
import { expandPath } from '../discovery.js'
import { summarize, summarizeFamilies } from '../catalog.js'
import { assignFamilies, passesFilter, type FamilyRule } from '../families.js'
import { readSkillFile, scanSkillDirs, type ExtraSkill } from '../skill-dirs.js'
import { clipEnd } from '../text.js'
import type { CapabilityEntry, CapabilitySource, HarnessContext, SkillDefinitionLike, SkillSummaryLike, SourceIndex, ViewContext } from '../types.js'

/** Directories scanned for skills the Harness catalog does not cover. */
export interface ExtraSkillDirs {
  /** User-level directories, expanded per working directory. */
  readonly dirs: readonly string[]
  /** Directories relative to the working directory. */
  readonly projectDirs: readonly string[]
  /** Minimum time between two scans; the merge itself runs on every refresh. */
  readonly rescanMs: number
}

/** Resolved skill-source configuration. */
export interface SkillSourceConfig {
  /** `brief`: names plus a short description; `names`: names only. */
  readonly indexMode: 'brief' | 'names'
  /** Character budget of a brief description. */
  readonly briefChars: number
  readonly families: readonly FamilyRule[]
  readonly allow: readonly string[]
  readonly deny: readonly string[]
  /** Extra directories, when the catalog also loads skills from the filesystem. */
  readonly extra?: ExtraSkillDirs
}

interface ScopeState {
  readonly entries: CapabilityEntry[]
  readonly descriptions: ReadonlyMap<string, string>
  /** Skills merged in from extra directories, by name. */
  readonly extra: ReadonlyMap<string, ExtraSkill>
}

interface DirCache {
  readonly at: number
  readonly skills: ReadonlyMap<string, ExtraSkill>
}

/**
 * Group skill names: a shared multi-word suffix (`*-history-ingest`) or prefix (`wiki-*`)
 * used by at least three skills names a family; the rest are `general`.
 * @param names - skill names.
 */
export function skillFamilies(names: readonly string[]): Map<string, string> {
  const suffixCount = new Map<string, number>()
  const prefixCount = new Map<string, number>()
  const parts = names.map((name) => name.split('-'))
  for (const words of parts) {
    if (words.length >= 3) {
      const suffix = words.slice(-2).join('-')
      suffixCount.set(suffix, (suffixCount.get(suffix) ?? 0) + 1)
    }
    if (words.length >= 2) prefixCount.set(words[0]!, (prefixCount.get(words[0]!) ?? 0) + 1)
  }
  const family = new Map<string, string>()
  names.forEach((name, i) => {
    const words = parts[i]!
    const suffix = words.length >= 3 ? words.slice(-2).join('-') : undefined
    if (suffix !== undefined && (suffixCount.get(suffix) ?? 0) >= 3) family.set(name, suffix)
    else if (words.length >= 2 && (prefixCount.get(words[0]!) ?? 0) >= 3) family.set(name, words[0]!)
    else family.set(name, 'general')
  })
  return family
}

/** Shorten a summary to a clause that fits the brief budget. */
function brief(summary: string, max: number): string {
  const flat = summary.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, clipEnd(flat, max))
  const boundary = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' — '), cut.lastIndexOf('，'))
  return `${(boundary > max * 0.5 ? cut.slice(0, boundary) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)).trim()}…`
}

/** The Harness skill catalog as a capability source. */
export class SkillSource implements CapabilitySource {
  readonly key = 'skills'
  private readonly states = new WeakMap<object, ScopeState>()
  private readonly scanned = new Map<string, DirCache>()
  private fallback: ScopeState | undefined

  constructor(
    private readonly skills: NonNullable<HarnessContext['skills']>,
    private readonly config: SkillSourceConfig,
  ) {}

  private state(view: ViewContext): ScopeState | undefined {
    return (view.scope !== undefined ? this.states.get(view.scope) : undefined) ?? this.fallback
  }

  /**
   * Scan the configured extra directories, at most once per `rescanMs` per directory set.
   * A working directory is part of the cache key because project directories resolve against it.
   */
  private async extraSkills(cwd: string | undefined): Promise<ReadonlyMap<string, ExtraSkill>> {
    const extra = this.config.extra
    if (extra === undefined) return new Map()
    const dirs = [...extra.dirs, ...extra.projectDirs.map((dir) => cwd === undefined ? '' : dir)]
      .map((dir) => dir === '' ? '' : expandPath(dir, cwd))
      .filter((dir) => dir !== '')
    if (dirs.length === 0) return new Map()
    const key = dirs.join('\u0000')
    const now = Date.now()
    const cached = this.scanned.get(key)
    if (cached !== undefined && now - cached.at < extra.rescanMs) return cached.skills
    const scan = await scanSkillDirs(dirs)
    const skills = new Map(scan.skills)
    this.scanned.set(key, { at: now, skills })
    return skills
  }

  async refresh(view: ViewContext, signal: AbortSignal): Promise<void> {
    const snapshot = await this.skills.snapshot({
      ...view.scope !== undefined ? { scope: view.scope } : {},
      ...view.cwd !== undefined ? { cwd: view.cwd } : {},
      signal,
    })
    // An incomplete discovery keeps the last good view, as the native catalog does.
    if (!snapshot.complete && this.state(view) !== undefined) return
    const extra = await this.extraSkills(view.cwd)
    const state = this.build(snapshot.skills, extra)
    if (view.scope !== undefined) this.states.set(view.scope, state)
    this.fallback = state
  }

  private build(skills: readonly SkillSummaryLike[], extra: ReadonlyMap<string, ExtraSkill>): ScopeState {
    const visible = skills.filter((skill) => skill.invocation.modelInvocable && passesFilter(skill.name, this.config.allow, this.config.deny))
    const nativeNames = new Set(visible.map((skill) => skill.name))
    // A native skill keeps its name: the Harness loader and `/name` both resolve through it.
    const extraVisible = [...extra.values()].filter((skill) => !nativeNames.has(skill.name))
    const names = [...nativeNames, ...extraVisible.map((skill) => skill.name)]
    const curated = assignFamilies(names, this.config.families)
    const heuristic = skillFamilies(names.filter((name) => !this.config.families.some((rule) => rule.match.length > 0 && curated.family.get(name) === rule.name)))
    const familyOf = (name: string) => this.config.families.find((rule) => curated.family.get(name) === rule.name)?.name ?? heuristic.get(name) ?? 'general'
    const entries: CapabilityEntry[] = visible.map((skill) => {
      const description = skill.whenToUse ? `${skill.description}\nWhen to use: ${skill.whenToUse}` : skill.description
      return {
        id: `skill:${skill.name}`,
        kind: 'skill' as const,
        source: this.key,
        name: skill.name,
        family: familyOf(skill.name),
        summary: summarize(skill.description, 200),
        description,
        readOnly: true,
      }
    })
    for (const skill of extraVisible) {
      entries.push({
        id: `skill:${skill.name}`,
        kind: 'skill',
        source: this.key,
        name: skill.name,
        family: familyOf(skill.name),
        summary: summarize(skill.description === '' ? `Skill directory ${skill.directory}` : skill.description, 200),
        description: skill.description === '' ? `Skill from ${skill.file}.` : skill.description,
        readOnly: true,
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { entries, descriptions: curated.descriptions, extra: new Map(extraVisible.map((skill) => [skill.name, skill])) }
  }

  entries(view: ViewContext): readonly CapabilityEntry[] {
    return this.state(view)?.entries ?? []
  }

  /**
   * Load a skill from an extra directory. Native skills are loaded by the Harness itself; this
   * is the fallback the `skill` tool uses when the native registry does not know the name.
   * @param name - skill name as indexed.
   * @param view - viewing context, which selects the scope and project directories.
   */
  async load(name: string, view: ViewContext): Promise<SkillDefinitionLike | undefined> {
    const skill = this.state(view)?.extra.get(name)
    return skill === undefined ? undefined : readSkillFile(skill)
  }

  index(view: ViewContext, entries: readonly CapabilityEntry[]): SourceIndex | undefined {
    const state = this.state(view)
    if (state === undefined || entries.length === 0) return undefined
    const families = summarizeFamilies(entries, state.descriptions, Number.POSITIVE_INFINITY)
    const byName = new Map(entries.map((entry) => [entry.name, entry]))
    return {
      source: this.key,
      title: 'skills — reusable task instructions',
      total: entries.length,
      families: this.config.indexMode === 'names' ? families : families.map((family) => ({
        ...family,
        members: family.examples.map((name) => ({ name, brief: brief(byName.get(name)?.summary ?? '', this.config.briefChars) })),
      })),
      listNames: true,
    }
  }
}
