/**
 * Native activation.
 *
 * When the model describes a catalog tool, the tool is also registered on that agent as an
 * ordinary Harness tool. From the next step the model calls it natively with its exact schema;
 * the Harness records a `tool-addition`, which routes declaring `toolUpdate` (deepseek-flash)
 * send as a deferred declaration plus a `tool_addition` block instead of rebuilding the tool
 * prefix. Calls still run through the catalog: switches, validation and on-demand server start.
 *
 * Activations live in memory. After a Host restart or a plugin reload they are restored from the
 * session's last request header, so the Harness does not record a removal and re-addition.
 * @module
 */
import type { CapabilityEntry, ContentBlock, HarnessAgent, ToolDefinitionLike, ToolExecutionLike } from './types.js'

/** Activation settings. */
export interface ActivationConfig {
  /** off: never; native: always; auto: only on routes that declare `toolUpdate`. */
  readonly mode: 'off' | 'native' | 'auto'
  /** Most tools one agent may hold natively at once; later describes fall back to the meta call. */
  readonly maxActive: number
  /** Schemas above this many bytes stay behind capability_call; 0 means no limit. */
  readonly maxSchemaBytes: number
}

/** Runs one catalog tool by id. */
export type RunTool = (id: string, argumentsValue: Record<string, unknown>, exec: ToolExecutionLike) => Promise<{ text: string }>

/** One natively loaded tool. */
export interface ActiveTool {
  readonly name: string
  readonly id: string
  readonly source: string
}

/** Provider-safe native name, the same shape the Harness MCP client uses. */
export function nativeToolName(entry: Pick<CapabilityEntry, 'source' | 'name'>): string | undefined {
  const server = entry.source.replace(/^mcp:/u, '').replace(/[^A-Za-z0-9_-]/gu, '_')
  const tool = entry.name.replace(/[^A-Za-z0-9_-]/gu, '_')
  const name = `mcp__${server}__${tool}`
  return name.length <= 64 ? name : undefined
}

interface Held extends ActiveTool {
  readonly dispose: () => void
}

/** Tracks natively activated tools per agent. */
export class Activator {
  private readonly active = new Map<string, Map<string, Held>>()

  constructor(
    private readonly config: ActivationConfig,
    private readonly run: RunTool,
    private readonly callToolName: string,
    private readonly warn: (message: string, error?: unknown) => void,
    /** Whether this agent's current route should receive native tools (auto mode). */
    private readonly routeAllows: (agent: HarnessAgent) => boolean = () => true,
  ) {}

  /** Whether activation applies to this agent at all. */
  applies(agent: HarnessAgent | undefined): agent is HarnessAgent & { ctx: NonNullable<HarnessAgent['ctx']> } {
    if (agent?.ctx === undefined || this.config.mode === 'off') return false
    return this.config.mode === 'native' || this.routeAllows(agent)
  }

  /**
   * Activate a described tool for the calling agent.
   * @returns a line for the describe result, or undefined when activation does not apply.
   */
  activate(entry: CapabilityEntry, exec: ToolExecutionLike): string | undefined {
    if (entry.kind !== 'tool' || !this.applies(exec.agent)) return undefined
    const agent = exec.agent
    const name = nativeToolName(entry)
    if (name === undefined) return undefined
    const owned = this.active.get(agent.id)
    if (owned?.has(name)) return `It is also available as the native tool \`${name}\`; call it directly.`
    if (this.config.maxSchemaBytes > 0 && (entry.schemaBytes ?? 0) > this.config.maxSchemaBytes) {
      return `Its schema is too large to load as a native tool; keep using ${this.callToolName}.`
    }
    if ((owned?.size ?? 0) >= this.config.maxActive) {
      return `This session already holds ${owned!.size} native catalog tools, the configured maximum; use ${this.callToolName}.`
    }
    if (!this.register(agent, entry, name)) return undefined
    return `Loaded as the native tool \`${name}\`: from your next step call it directly with these parameters instead of ${this.callToolName}.`
  }

  /**
   * Re-register tools an agent already had, such as after a Host restart.
   * @param agent - the agent whose session declared the tools.
   * @param names - native names from the session's last request header.
   * @param resolve - maps a native name to the current catalog entry, when it still exists.
   * @returns the names restored.
   */
  restore(agent: HarnessAgent, names: readonly string[], resolve: (name: string) => CapabilityEntry | undefined): string[] {
    if (!this.applies(agent)) return []
    const restored: string[] = []
    for (const name of names) {
      if (this.active.get(agent.id)?.has(name)) continue
      if ((this.active.get(agent.id)?.size ?? 0) >= this.config.maxActive) break
      const entry = resolve(name)
      if (entry === undefined || entry.kind !== 'tool' || nativeToolName(entry) !== name) continue
      if (this.register(agent, entry, name)) restored.push(name)
    }
    return restored
  }

  /** Release one tool, or every tool, of an agent. */
  release(agentId: string, name?: string): void {
    const owned = this.active.get(agentId)
    if (owned === undefined) return
    for (const held of [...owned.values()]) if (name === undefined || held.name === name) held.dispose()
  }

  /** Release every tool whose capability is no longer enabled for its agent. */
  prune(isEnabled: (id: string, agentId: string) => boolean): void {
    for (const [agentId, owned] of this.active) {
      for (const held of [...owned.values()]) if (!isEnabled(held.id, agentId)) held.dispose()
    }
  }

  /** Tools active for one agent. */
  list(agentId: string): ActiveTool[] {
    return [...(this.active.get(agentId)?.values() ?? [])].map(({ name, id, source }) => ({ name, id, source }))
  }

  /** Drop every activation. */
  dispose(): void {
    for (const owned of [...this.active.values()]) for (const held of [...owned.values()]) held.dispose()
    this.active.clear()
  }

  private register(agent: HarnessAgent & { ctx: NonNullable<HarnessAgent['ctx']> }, entry: CapabilityEntry, name: string): boolean {
    const run = this.run
    const definition: ToolDefinitionLike = {
      name,
      description: `${entry.description}\n\n(Capability ${entry.id}, loaded from the capability catalog.)`,
      parameters: entry.inputSchema ?? { type: 'object' },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render: (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: (value as { text: string }).text }],
      },
      async execute(args: unknown, toolExec: ToolExecutionLike) {
        return run(entry.id, (args ?? {}) as Record<string, unknown>, toolExec)
      },
      isConcurrencySafe: () => entry.readOnly === true,
      presentCall: (args: unknown) => ({ card: 'generic', title: `Run ${entry.id}`, kind: entry.readOnly === true ? 'read' : 'execute', rawInput: JSON.stringify(args ?? {}) }),
    }
    const agentCtx = agent.ctx
    const owned = this.active.get(agent.id) ?? new Map<string, Held>()
    try {
      const dispose = agentCtx.effect(() => {
        const unregister = agentCtx.tools.register(definition)
        return () => {
          unregister()
          owned.delete(name)
          if (owned.size === 0 && this.active.get(agent.id) === owned) this.active.delete(agent.id)
        }
      }, `capability-catalog.native.${name}`)
      owned.set(name, { name, id: entry.id, source: entry.source, dispose })
      this.active.set(agent.id, owned)
      return true
    } catch (error) {
      this.warn(`capability-catalog: could not activate ${name} for ${agent.id}`, error)
      return false
    }
  }
}
