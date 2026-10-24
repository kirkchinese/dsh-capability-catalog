/**
 * MCP source: discovers a server's tools, caches the catalog on disk, connects on demand,
 * and disconnects after an idle period.
 *
 * The cached catalog lets the standing index appear without starting the server at every
 * Harness launch; the server process runs only while the model is actually using it.
 * @module
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { summarize, summarizeFamilies } from '../catalog.js'
import { assignFamilies, globToRegExp, passesFilter, type FamilyRule } from '../families.js'
import type { CallOutcome, CapabilityEntry, CapabilitySource, JsonSchema, SourceIndex } from '../types.js'

/** Resolved configuration of one MCP server. */
export interface McpServerConfig {
  readonly name: string
  readonly enabled: boolean
  readonly title?: string
  readonly description?: string
  readonly transport: 'stdio' | 'streamable-http'
  readonly command?: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers: Readonly<Record<string, string>>
  readonly allowTools: readonly string[]
  readonly denyTools: readonly string[]
  readonly families: readonly FamilyRule[]
  readonly idleDisconnectMs: number
  readonly callTimeoutMs: number
  readonly discoveryTimeoutMs: number
  readonly catalogTtlMs: number
}

/** Tool record as cached on disk. */
interface CachedTool {
  readonly name: string
  readonly description: string
  readonly inputSchema: JsonSchema
  readonly readOnly?: boolean
  /** Family the server declares in `_meta` (any namespace with a string `family`). */
  readonly family?: string
}

/** Read a server-declared family from MCP `_meta`, under any vendor namespace. */
export function declaredFamily(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const direct = (meta as Record<string, unknown>).family
  if (typeof direct === 'string' && direct !== '') return direct
  for (const value of Object.values(meta)) {
    if (value !== null && typeof value === 'object' && typeof (value as Record<string, unknown>).family === 'string') {
      const family = (value as Record<string, string>).family
      if (family !== '') return family
    }
  }
  return undefined
}

/** On-disk catalog cache of one server. */
interface CatalogCache {
  readonly version: 1
  readonly key: string
  readonly fetchedAt: number
  readonly server?: { readonly name?: string; readonly version?: string }
  readonly instructions?: string
  readonly tools: readonly CachedTool[]
}

type Logger = { info(...a: unknown[]): void; warn(...a: unknown[]): void; debug(...a: unknown[]): void }

/** Hash of the launch-defining fields; a change invalidates the cache. */
export function cacheKey(config: McpServerConfig): string {
  const identity = {
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: Object.entries(config.env).sort(),
    cwd: config.cwd,
    url: config.url,
    headers: Object.keys(config.headers).sort(),
  }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Reject a pending promise after a deadline. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** One MCP server exposed as a capability source. */
export class McpSource implements CapabilitySource {
  readonly key: string
  private catalog: CatalogCache | undefined
  private entryList: CapabilityEntry[] = []
  private descriptions = new Map<string, string>()
  private failure: string | undefined
  private client: Client | undefined
  private connecting: Promise<Client> | undefined
  private idleTimer: NodeJS.Timeout | undefined
  private inFlight = 0
  private disposed = false
  private refreshing: Promise<void> | undefined
  private started = false

  /** Whether discovery has been allowed to run (the server is not switched off). */
  get discovered(): boolean {
    return this.started
  }

  constructor(
    private readonly config: McpServerConfig,
    private readonly cacheDir: string,
    private readonly logger: Logger,
  ) {
    this.key = `mcp:${config.name}`
  }

  private get cachePath(): string {
    return join(this.cacheDir, `mcp-${this.config.name}.json`)
  }

  /**
   * Load the cached catalog and discover when it is missing or belongs to another launch identity.
   * A stale but matching cache is used immediately and refreshed in the background.
   */
  async start(options: { discover?: boolean } = {}): Promise<void> {
    const allowDiscovery = options.discover ?? true
    const key = cacheKey(this.config)
    try {
      const cached = JSON.parse(await readFile(this.cachePath, 'utf8')) as CatalogCache
      if (cached.version === 1 && cached.key === key && Array.isArray(cached.tools)) this.adopt(cached)
    } catch {
      // Missing or unreadable cache: discover below.
    }
    if (!allowDiscovery) return
    this.started = true
    if (this.catalog === undefined) {
      await this.discover(false).catch((error: unknown) => {
        this.failure = `discovery failed: ${error instanceof Error ? error.message : String(error)}`
        this.logger.warn(`capability-catalog: ${this.key} ${this.failure}`)
      })
    } else if (Date.now() - this.catalog.fetchedAt > this.config.catalogTtlMs) {
      this.refreshing ??= this.discover(false)
        .catch((error: unknown) => this.logger.warn(`capability-catalog: ${this.key} background refresh failed`, error))
        .finally(() => { this.refreshing = undefined })
    }
  }

  /**
   * Connect, list every tool page and cache the result.
   * @param keepAlive - keep the connection for its idle period; startup discovery closes it at once.
   */
  async discover(keepAlive = true): Promise<void> {
    const hadClient = this.client !== undefined
    const client = await this.ensureClient()
    this.inFlight++
    try {
      const tools: CachedTool[] = []
      let cursor: string | undefined
      do {
        const page = await withTimeout(client.listTools(cursor === undefined ? {} : { cursor }), this.config.discoveryTimeoutMs, `${this.key} tools/list`)
        for (const tool of page.tools) {
          const family = declaredFamily((tool as { _meta?: unknown })._meta)
          tools.push({
            ...family ? { family } : {},
            name: tool.name,
            description: tool.description ?? '',
            inputSchema: (tool.inputSchema ?? { type: 'object' }) as JsonSchema,
            ...tool.annotations?.readOnlyHint === true ? { readOnly: true } : {},
          })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      const version = client.getServerVersion()
      const instructions = client.getInstructions()
      const cache: CatalogCache = {
        version: 1,
        key: cacheKey(this.config),
        fetchedAt: Date.now(),
        ...version ? { server: { name: version.name, version: version.version } } : {},
        ...instructions ? { instructions } : {},
        tools,
      }
      this.adopt(cache)
      this.failure = undefined
      await mkdir(dirname(this.cachePath), { recursive: true })
      const temp = `${this.cachePath}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(cache), { mode: 0o600 })
      await rename(temp, this.cachePath)
    } finally {
      this.release()
      if (!keepAlive && !hadClient && this.inFlight === 0) {
        this.clearIdle()
        await this.disconnect('discovery finished')
      }
    }
  }

  private adopt(cache: CatalogCache): void {
    this.catalog = cache
    const visible = cache.tools.filter((tool) => passesFilter(tool.name, this.config.allowTools, this.config.denyTools))
    // Curated rules win; then families the server declares; then the name heuristic.
    const curatedNames = new Set(visible.filter((tool) => this.config.families.some((rule) => rule.match.some((pattern) => globToRegExp(pattern).test(tool.name)))).map((tool) => tool.name))
    const undeclared = visible.filter((tool) => curatedNames.has(tool.name) || tool.family === undefined).map((tool) => tool.name)
    const { family, descriptions } = assignFamilies(undeclared, this.config.families)
    for (const tool of visible) if (!curatedNames.has(tool.name) && tool.family !== undefined) family.set(tool.name, tool.family)
    this.descriptions = descriptions
    this.entryList = visible.map((tool) => {
      const schemaBytes = Buffer.byteLength(JSON.stringify(tool.inputSchema))
      return {
        id: `${this.key}/${tool.name}`,
        kind: 'tool' as const,
        source: this.key,
        name: tool.name,
        family: family.get(tool.name) ?? 'misc',
        summary: summarize(tool.description),
        description: tool.description,
        inputSchema: tool.inputSchema,
        schemaBytes,
        ...tool.readOnly ? { readOnly: true } : {},
      }
    })
  }

  entries(): readonly CapabilityEntry[] {
    return this.entryList
  }

  /** Server name as configured. */
  get name(): string {
    return this.config.name
  }

  /** Display title for settings views. */
  get title(): string {
    return this.config.title ?? this.config.name
  }

  /** Configured default enablement. */
  get configuredEnabled(): boolean {
    return this.config.enabled
  }

  /** Number of tools after allow/deny filtering. */
  get toolCount(): number {
    return this.entryList.length
  }

  /** Discovery failure, if the server has no usable catalog. */
  get problem(): string | undefined {
    return this.failure
  }

  index(_view: unknown, entries: readonly CapabilityEntry[]): SourceIndex | undefined {
    if (entries.length === 0 && !this.failure) return undefined
    const title = this.config.title ?? `MCP server "${this.config.name}"`
    const description = this.config.description ?? (this.catalog?.instructions ? summarize(this.catalog.instructions, 240) : undefined)
    return {
      source: this.key,
      title: `${this.key} — ${title}`,
      ...description ? { description } : {},
      total: entries.length,
      families: summarizeFamilies(entries, this.descriptions),
      ...this.failure && this.entryList.length === 0 ? { note: `${this.failure}; tools are unavailable until the next successful discovery` } : {},
    }
  }

  private async ensureClient(): Promise<Client> {
    if (this.disposed) throw new Error(`${this.key} is disabled or unloaded`)
    this.clearIdle()
    if (this.client) return this.client
    this.connecting ??= this.connect().finally(() => { this.connecting = undefined })
    return this.connecting
  }

  private async connect(): Promise<Client> {
    const config = this.config
    let transport
    if (config.transport === 'stdio') {
      if (!config.command) throw new Error(`${this.key}: stdio transport requires "command"`)
      transport = new StdioClientTransport({
        command: config.command,
        args: [...config.args],
        env: { ...scrubbedParentEnv(), ...config.env },
        ...config.cwd ? { cwd: config.cwd } : {},
        stderr: 'ignore',
      })
    } else {
      if (!config.url) throw new Error(`${this.key}: streamable-http transport requires "url"`)
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { ...config.headers } } })
    }
    const client = new Client({ name: 'dsh-capability-catalog', version: '0.1.2' })
    client.onclose = () => {
      if (this.client === client) this.client = undefined
    }
    await withTimeout(client.connect(transport), this.config.discoveryTimeoutMs, `${this.key} connect`)
    if (this.disposed) {
      await client.close().catch(() => undefined)
      throw new Error(`${this.key} was unloaded while connecting`)
    }
    this.client = client
    this.logger.info(`capability-catalog: connected ${this.key}`)
    return client
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
    if (this.inFlight > 0 || this.disposed) return
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.inFlight === 0) void this.disconnect('idle')
    }, this.config.idleDisconnectMs)
    this.idleTimer.unref?.()
  }

  /** Close the live connection, if any. */
  async disconnect(reason: string): Promise<void> {
    const client = this.client
    this.client = undefined
    if (client) {
      this.logger.info(`capability-catalog: disconnecting ${this.key} (${reason})`)
      await client.close().catch((error: unknown) => this.logger.warn(`capability-catalog: closing ${this.key} failed`, error))
    }
  }

  /** Whether a server process or connection is currently live. */
  get connected(): boolean {
    return this.client !== undefined
  }

  async call(entry: CapabilityEntry, args: Record<string, unknown>, signal: AbortSignal): Promise<CallOutcome> {
    const client = await this.ensureClient()
    this.inFlight++
    try {
      const result = await client.callTool({ name: entry.name, arguments: args }, { signal, timeout: this.config.callTimeoutMs })
      const content = Array.isArray(result.content) ? result.content as unknown[] : []
      return {
        content,
        ...result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {},
        ...result.isError === true ? { isError: true } : {},
      }
    } finally {
      this.release()
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.clearIdle()
    const pending = this.connecting
    await this.disconnect('unload')
    if (pending) await pending.then((client) => client.close()).catch(() => undefined)
    await this.refreshing
  }
}
