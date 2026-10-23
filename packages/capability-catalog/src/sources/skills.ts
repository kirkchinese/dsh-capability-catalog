/**
 * Skill source: indexes the Harness skill catalog by family and name only.
 *
 * The native catalog repeats every description (up to 500 characters each) in every
 * session and re-appends the whole list on any change. This source keeps names in the
 * standing index and leaves descriptions to search.
 * @module
 */
import { summarize, summarizeFamilies } from '../catalog.js'
import { assignFamilies, passesFilter, type FamilyRule } from '../families.js'
import type { CapabilityEntry, CapabilitySource, HarnessContext, SkillSummaryLike, SourceIndex, ViewContext } from '../types.js'

/** Resolved skill-source configuration. */
export interface SkillSourceConfig {
  /** `brief`: names plus a short description; `names`: names only. */
  readonly indexMode: 'brief' | 'names'
  /** Character budget of a brief description. */
  readonly briefChars: number
  readonly families: readonly FamilyRule[]
  readonly allow: readonly string[]
  readonly deny: readonly string[]
}

interface ScopeState {
  readonly entries: CapabilityEntry[]
  readonly descriptions: Map<string, string>
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
  const cut = flat.slice(0, max)
  const boundary = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' — '), cut.lastIndexOf('，'))
  return `${(boundary > max * 0.5 ? cut.slice(0, boundary) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max)).trim()}…`
}

/** The Harness skill catalog as a capability source. */
export class SkillSource implements CapabilitySource {
  readonly key = 'skills'
  private readonly states = new WeakMap<object, ScopeState>()
  private fallback: ScopeState | undefined

  constructor(
    private readonly skills: NonNullable<HarnessContext['skills']>,
    private readonly config: SkillSourceConfig,
  ) {}

  private state(view: ViewContext): ScopeState | undefined {
    return (view.scope !== undefined ? this.states.get(view.scope) : undefined) ?? this.fallback
  }

  async refresh(view: ViewContext, signal: AbortSignal): Promise<void> {
    const snapshot = await this.skills.snapshot({
      ...view.scope !== undefined ? { scope: view.scope } : {},
      ...view.cwd !== undefined ? { cwd: view.cwd } : {},
      signal,
    })
    // An incomplete discovery keeps the last good view, as the native catalog does.
    if (!snapshot.complete && this.state(view) !== undefined) return
    const state = this.build(snapshot.skills)
    if (view.scope !== undefined) this.states.set(view.scope, state)
    this.fallback = state
  }

  private build(skills: readonly SkillSummaryLike[]): ScopeState {
    const visible = skills.filter((skill) => skill.invocation.modelInvocable && passesFilter(skill.name, this.config.allow, this.config.deny))
    const names = visible.map((skill) => skill.name)
    const curated = assignFamilies(names, this.config.families)
    const heuristic = skillFamilies(names.filter((name) => !this.config.families.some((rule) => rule.match.length > 0 && curated.family.get(name) === rule.name)))
    const entries = visible.map((skill) => {
      const ruleFamily = this.config.families.find((rule) => curated.family.get(skill.name) === rule.name)?.name
      const description = skill.whenToUse ? `${skill.description}\nWhen to use: ${skill.whenToUse}` : skill.description
      return {
        id: `skill:${skill.name}`,
        kind: 'skill' as const,
        source: this.key,
        name: skill.name,
        family: ruleFamily ?? heuristic.get(skill.name) ?? 'general',
        summary: summarize(skill.description, 200),
        description,
        readOnly: true,
      }
    })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return { entries, descriptions: curated.descriptions }
  }

  entries(view: ViewContext): readonly CapabilityEntry[] {
    return this.state(view)?.entries ?? []
  }

  index(view: ViewContext): SourceIndex | undefined {
    const state = this.state(view)
    if (state === undefined || state.entries.length === 0) return undefined
    const families = summarizeFamilies(state.entries, state.descriptions, Number.POSITIVE_INFINITY)
    const byName = new Map(state.entries.map((entry) => [entry.name, entry]))
    return {
      source: this.key,
      title: 'skills — reusable task instructions',
      total: state.entries.length,
      families: this.config.indexMode === 'names' ? families : families.map((family) => ({
        ...family,
        members: family.examples.map((name) => ({ name, brief: brief(byName.get(name)?.summary ?? '', this.config.briefChars) })),
      })),
      listNames: true,
    }
  }
}
