/**
 * Native activation (prototype, off by default).
 *
 * When the model describes a catalog tool, the tool is also registered on that agent as an
 * ordinary Harness tool. From the next step the model calls it natively with its exact schema;
 * the Harness records a `tool-addition`, which routes with `toolUpdate` (deepseek-flash) send as
 * a deferred declaration plus a `tool_addition` block instead of rebuilding the tool prefix.
 * Calls still run through the catalog: switches, validation, and on-demand server start apply.
 * @module
 */
import type { CapabilityEntry, ContentBlock, ToolDefinitionLike, ToolExecutionLike } from './types.js'

/** Activation settings. */
export interface ActivationConfig {
  readonly mode: 'off' | 'native'
  /** Most tools one agent may hold natively at once; later describes fall back to the meta call. */
  readonly maxActive: number
  /** Schemas above this size stay behind capability_call. */
  readonly maxSchemaBytes: number
}

/** Runs one catalog tool by id. */
export type RunTool = (id: string, argumentsValue: Record<string, unknown>, exec: ToolExecutionLike) => Promise<{ text: string }>

/** Provider-safe native name, the same shape the Harness MCP client uses. */
export function nativeToolName(entry: CapabilityEntry): string | undefined {
  const server = entry.source.replace(/^mcp:/u, '').replace(/[^A-Za-z0-9_-]/gu, '_')
  const tool = entry.name.replace(/[^A-Za-z0-9_-]/gu, '_')
  const name = `mcp__${server}__${tool}`
  return name.length <= 64 ? name : undefined
}

/** Tracks natively activated tools per agent. */
export class Activator {
  private readonly active = new Map<string, Map<string, () => void>>()

  constructor(
    private readonly config: ActivationConfig,
    private readonly run: RunTool,
    private readonly callToolName: string,
    private readonly warn: (message: string, error?: unknown) => void,
  ) {}

  /**
   * Activate a described tool for the calling agent.
   * @returns a line for the describe result, or undefined when activation does not apply.
   */
  activate(entry: CapabilityEntry, exec: ToolExecutionLike): string | undefined {
    if (this.config.mode !== 'native' || entry.kind !== 'tool') return undefined
    const agent = exec.agent
    const agentCtx = agent?.ctx
    if (agent === undefined || agentCtx === undefined) return undefined
    const name = nativeToolName(entry)
    if (name === undefined) return undefined
    const owned = this.active.get(agent.id) ?? new Map<string, () => void>()
    if (owned.has(name)) return `It is also available as the native tool \`${name}\`; call it directly.`
    if ((entry.schemaBytes ?? 0) > this.config.maxSchemaBytes) {
      return `Its schema is too large to load as a native tool; keep using ${this.callToolName}.`
    }
    if (owned.size >= this.config.maxActive) {
      return `This session already holds ${owned.size} native catalog tools, the configured maximum; use ${this.callToolName}.`
    }
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
    try {
      const dispose = agentCtx.effect(() => {
        const unregister = agentCtx.tools.register(definition)
        return () => {
          unregister()
          owned.delete(name)
        }
      }, `capability-catalog.native.${name}`)
      owned.set(name, dispose)
      this.active.set(agent.id, owned)
    } catch (error) {
      this.warn(`capability-catalog: could not activate ${name} for ${agent.id}`, error)
      return undefined
    }
    return `Loaded as the native tool \`${name}\`: from your next step call it directly with these parameters instead of ${this.callToolName}.`
  }

  /** Names active for one agent. */
  activeFor(agentId: string): string[] {
    return [...(this.active.get(agentId)?.keys() ?? [])]
  }

  /** Drop every activation. */
  dispose(): void {
    for (const owned of this.active.values()) for (const dispose of [...owned.values()]) dispose()
    this.active.clear()
  }
}
