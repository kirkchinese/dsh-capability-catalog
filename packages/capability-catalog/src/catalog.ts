/**
 * The catalog: merges sources, renders the standing index, and answers lookups.
 * @module
 */
import { SearchIndex, type SearchHit } from './search.js'
import type { CapabilityEntry, CapabilitySource, FamilySummary, SourceIndex, ViewContext } from './types.js'

/**
 * Derive a one-line summary from a description.
 * @param description - full text.
 * @param max - character budget.
 */
export function summarize(description: string, max = 160): string {
  const flat = description.replace(/\s+/gu, ' ').trim()
  const sentence = /^(.+?[.!?。！？])(\s|$)/u.exec(flat)?.[1] ?? flat
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1)}…`
}

/**
 * Summarize families of a source's entries.
 * @param entries - entries of one source.
 * @param descriptions - optional family descriptions.
 * @param examples - representative names per family.
 */
export function summarizeFamilies(
  entries: readonly CapabilityEntry[],
  descriptions: ReadonlyMap<string, string> = new Map(),
  examples = 3,
): FamilySummary[] {
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const group = groups.get(entry.family)
    if (group) group.push(entry.name)
    else groups.set(entry.family, [entry.name])
  }
  return [...groups.entries()]
    .map(([name, members]) => ({
      name,
      count: members.length,
      examples: [...members].sort().slice(0, examples),
      ...descriptions.has(name) ? { description: descriptions.get(name)! } : {},
    }))
    .sort((a, b) => (a.name === 'misc' ? 1 : 0) - (b.name === 'misc' ? 1 : 0) || b.count - a.count || a.name.localeCompare(b.name))
}

/** The tool names the index tells the model to use. */
export interface MetaToolNames {
  readonly search: string
  readonly describe: string
  readonly call: string
  readonly skill: string
}

/** Merged view over every registered source. */
export class Catalog {
  private readonly sources = new Map<string, CapabilitySource>()
  private cache: { key: string; index: SearchIndex } | undefined
  /** Decides whether an entry is enabled for a viewer; everything is enabled by default. */
  isEnabled: (entry: CapabilityEntry, view: ViewContext) => boolean = () => true

  /**
   * Add a source; returns its disposer.
   * @param source - capability source with a unique key.
   */
  add(source: CapabilitySource): () => void {
    if (this.sources.has(source.key)) throw new Error(`capability-catalog: duplicate source "${source.key}"`)
    this.sources.set(source.key, source)
    this.cache = undefined
    return () => {
      if (this.sources.get(source.key) === source) this.sources.delete(source.key)
      this.cache = undefined
    }
  }

  list(): CapabilitySource[] {
    return [...this.sources.values()]
  }

  source(key: string): CapabilitySource | undefined {
    return this.sources.get(key)
  }

  /** Every entry enabled for the viewer. */
  entries(view: ViewContext): CapabilityEntry[] {
    return this.allEntries(view).filter((entry) => this.isEnabled(entry, view))
  }

  /** Every entry, enabled or not (for settings views and precise error messages). */
  allEntries(view: ViewContext): CapabilityEntry[] {
    return this.list().flatMap((source) => source.entries(view))
  }

  /**
   * Find one entry by id, accepting a bare name when it is unambiguous.
   * @param id - entry id or bare name.
   * @param view - viewing scope.
   */
  find(id: string, view: ViewContext, includeDisabled = false): CapabilityEntry | { ambiguous: CapabilityEntry[] } | undefined {
    const entries = includeDisabled ? this.allEntries(view) : this.entries(view)
    const exact = entries.find((entry) => entry.id === id)
    if (exact) return exact
    const named = entries.filter((entry) => entry.name === id || entry.name === id.replace(/^skill:/u, ''))
    if (named.length === 1) return named[0]
    if (named.length > 1) return { ambiguous: named }
    return undefined
  }

  /**
   * Keyword search across sources.
   * @param query - free text.
   * @param view - viewing scope.
   * @param filter - optional source, family and kind filters.
   * @param limit - maximum hits.
   */
  search(query: string, view: ViewContext, filter: { source?: string; family?: string; kind?: string }, limit: number): SearchHit[] {
    const entries = this.entries(view).filter((entry) =>
      (filter.source === undefined || entry.source === filter.source) &&
      (filter.family === undefined || entry.family === filter.family) &&
      (filter.kind === undefined || entry.kind === filter.kind))
    if (query.trim() === '') return entries.slice(0, limit).map((entry) => ({ entry, score: 0 }))
    const key = entries.map((entry) => entry.id).join('\n')
    if (this.cache?.key !== key) this.cache = { key, index: new SearchIndex(entries) }
    return this.cache.index.search(query, limit)
  }

  /** Index blocks of every source, in registration order. */
  indexes(view: ViewContext): SourceIndex[] {
    return this.list()
      .map((source) => source.index(view, source.entries(view).filter((entry) => this.isEnabled(entry, view))))
      .filter((index): index is SourceIndex => index !== undefined)
  }

  /**
   * Render the standing index text.
   * @param view - viewing scope.
   * @param names - meta-tool names to reference.
   * @param skillTakeover - whether skills load through the replacement `skill` tool.
   * @returns prompt text, or an empty string when there is nothing to index.
   */
  renderIndex(view: ViewContext, names: MetaToolNames, skillTakeover: boolean): string {
    const blocks = this.indexes(view)
    if (blocks.length === 0) return ''
    const lines: string[] = [
      '## Capability catalog',
      '',
      `The capabilities below exist but are not declared as tools, so their parameters are not in context. ` +
        `Find one with \`${names.search}\` (keywords, or \`family\` to browse), read its exact parameters with \`${names.describe}\`, ` +
        `then run it with \`${names.call}\`.` +
        (skillTakeover ? ` Load a skill with the \`${names.skill}\` tool; \`${names.search}\` with kind "skill" returns skill descriptions.` : ''),
      'When a task matches a family below, search before concluding that no tool exists.',
    ]
    for (const block of blocks) {
      lines.push('')
      lines.push(`### ${block.title} (${block.total})`)
      if (block.description) lines.push(block.description)
      if (block.note) lines.push(`Note: ${block.note}`)
      for (const family of block.families) {
        const description = family.description ? ` — ${family.description}` : ''
        if (family.members?.some((member) => member.brief)) {
          lines.push(`- ${family.name} (${family.count})${description}:`)
          for (const member of family.members) lines.push(member.brief ? `  - ${member.name}: ${member.brief}` : `  - ${member.name}`)
          continue
        }
        const members = block.listNames ? family.examples.join(', ') : `${family.examples.join(', ')}${family.count > family.examples.length ? ', …' : ''}`
        lines.push(`- ${family.name} (${family.count})${description}: ${members}`)
      }
    }
    return lines.join('\n')
  }

  async refresh(view: ViewContext, signal: AbortSignal): Promise<void> {
    await Promise.all(this.list().map((source) => source.refresh?.(view, signal)))
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.list().map((source) => source.dispose?.()))
    this.sources.clear()
  }
}
