/**
 * Shared vocabulary for the capability catalog and the minimal Harness surface it uses.
 *
 * The Harness host types are declared structurally here instead of importing every
 * `@deepseek-ai/*` package: the plugin only touches a handful of members, and a
 * structural declaration keeps one source build working across compatible releases.
 * @module
 */

/** A JSON Schema object as published by an MCP server or a Harness tool. */
export type JsonSchema = Record<string, unknown>

/** One discoverable capability, regardless of where it comes from. */
export interface CapabilityEntry {
  /** Globally unique id: `<source>/<name>` for tools, `skill:<name>` for skills. */
  readonly id: string
  readonly kind: 'tool' | 'skill'
  /** Source key such as `mcp:rea` or `skills`. */
  readonly source: string
  /** Name inside its source, sent to the source when called. */
  readonly name: string
  /** Capability family used to group the index and to browse. */
  readonly family: string
  /** One-line summary for listings and search results. */
  readonly summary: string
  /** Complete description returned by describe. */
  readonly description: string
  /** Raw input schema; the only authority for argument validation. */
  readonly inputSchema?: JsonSchema
  /** Serialized size of {@link inputSchema} in bytes. */
  readonly schemaBytes?: number
  /** True when the source declares the capability free of side effects. */
  readonly readOnly?: boolean
}

/** Family description shown in the index. */
export interface FamilySummary {
  readonly name: string
  readonly description?: string
  readonly count: number
  /** A few representative member names. */
  readonly examples: readonly string[]
  /** Every member with a brief description, for sources whose index lists members. */
  readonly members?: readonly { readonly name: string; readonly brief?: string }[]
}

/** Index block contributed by one source. */
export interface SourceIndex {
  readonly source: string
  readonly title: string
  readonly description?: string
  readonly total: number
  readonly families: readonly FamilySummary[]
  /** Optional note, for example a discovery failure. */
  readonly note?: string
  /** When true, list every member name in the index (cheap sources such as skills). */
  readonly listNames?: boolean
}

/** Result of calling a tool capability. */
export interface CallOutcome {
  readonly content: unknown[]
  readonly structuredContent?: unknown
  readonly isError?: boolean
}

/** A provider of capabilities. */
export interface CapabilitySource {
  readonly key: string
  /** Current entries for the viewing scope. */
  entries(view: ViewContext): readonly CapabilityEntry[]
  /** Index block for the viewing scope, or undefined when the source has nothing to show. */
  index(view: ViewContext): SourceIndex | undefined
  /** Refresh asynchronous state before a model step. */
  refresh?(view: ViewContext, signal: AbortSignal): Promise<void>
  /** Execute a tool entry. */
  call?(entry: CapabilityEntry, args: Record<string, unknown>, signal: AbortSignal): Promise<CallOutcome>
  dispose?(): Promise<void>
}

/** Which agent is looking at the catalog. */
export interface ViewContext {
  /** Harness scope key of the viewing agent, when known. */
  readonly scope?: object
  /** Working directory of the viewing agent, when known. */
  readonly cwd?: string
}

// ---------------------------------------------------------------------------
// Minimal structural Harness surface
// ---------------------------------------------------------------------------

export type ContentBlock = { type: 'text'; text: string } | Record<string, unknown>

export interface ToolCallView {
  card: 'generic'
  title: string
  kind?: 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other'
  rawInput?: string
}

export interface HarnessAgent {
  readonly id: string
  readonly ctx?: HarnessContext
}

export interface ToolExecutionLike {
  readonly callId: string
  readonly name: string
  readonly arguments: unknown
  readonly agent?: HarnessAgent
  readonly signal: AbortSignal
}

export interface ToolDefinitionLike {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema
  readonly output: {
    readonly schema: JsonSchema
    render(args: unknown, value: unknown): ContentBlock[]
  }
  execute(args: unknown, exec: ToolExecutionLike): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args: unknown): ToolCallView | undefined
  timeoutMs?: number
}

export interface SkillSummaryLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  readonly source: string
  readonly provider: string
  readonly resourceBase?: Record<string, unknown>
}

export interface SkillDefinitionLike extends SkillSummaryLike {
  readonly content: string
}

export interface SkillViewOptionsLike {
  readonly scope?: object
  readonly cwd?: string
  readonly signal?: AbortSignal
}

export interface HarnessContext {
  readonly root: HarnessContext
  effect(execute: () => (() => void) | void, label?: string): () => void
  on(name: string, listener: (...args: any[]) => any): () => void
  get(name: string): unknown
  logger(name: string): { info(...a: unknown[]): void; warn(...a: unknown[]): void; debug(...a: unknown[]): void }
  tools: {
    register(definition: ToolDefinitionLike): () => void
    restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
    get(name: string, scope?: object): unknown
  }
  systemPrompt: {
    section(section: { name: string; order: number; text: string | ((context: { scope?: object }) => string); interpolate?: boolean }): () => void
    getSectionOrder(name: string): number
  }
  skills?: {
    snapshot(options?: SkillViewOptionsLike): Promise<{ skills: SkillSummaryLike[]; complete: boolean }>
    list(options?: SkillViewOptionsLike): Promise<SkillSummaryLike[]>
    get(name: string, options?: SkillViewOptionsLike): Promise<SkillDefinitionLike | undefined>
  }
  workingDirectory?: {
    ensure(agent: HarnessAgent, signal?: AbortSignal): Promise<string>
  }
  [key: string]: unknown
}
