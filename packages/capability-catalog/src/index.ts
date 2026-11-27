/**
 * Lazy capability catalog for DeepSeek Harness.
 *
 * One compact index in the system prompt tells the model which capability families exist;
 * three fixed tools find, describe and run them. MCP tools and skills share one catalog, so
 * hundreds of capabilities cost a few hundred prompt tokens instead of every schema on every
 * request, and the provider tool array never changes during a session.
 * @module @kirkchinese/dsh-capability-catalog
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { Catalog, type MetaToolNames } from './catalog.js'
import { DEFAULT_DISCOVERY_FILES, scanMcpConfigFiles, type McpDiscoveryConfig } from './discovery.js'
import { McpSource, type McpServerConfig } from './sources/mcp.js'
import { SkillSource } from './sources/skills.js'
import { createTools, type ToolLimits } from './tools.js'
import { Activator, nativeToolName, type ActivationConfig } from './activation.js'
import { ToggleStore } from './toggles.js'
import { CatalogRemote, type CatalogRemoteApi } from './remote.js'
import type { FamilyRule } from './families.js'
import type { HarnessAgent, HarnessContext, ToolExecutionLike, ViewContext } from './types.js'

export { Catalog } from './catalog.js'
export { compactSignature, resolvePointer } from './schema-view.js'
export { SearchIndex, tokenize } from './search.js'
export type * from './types.js'

export const name = 'capability-catalog'

/** Service through which other rows contribute MCP servers to the catalog. */
export interface CapabilityCatalogService {
  addMcpServer(server: McpServerConfig): Promise<() => Promise<void>>
}
export const inject = ['tools', 'systemPrompt']

/** Position right after the Harness MCP server section. */
const SECTION_ORDER = 3150

const FamilyRuleSchema = z.object({
  name: z.string().required().description('Family name shown in the index.'),
  description: z.string().description('Short family description shown in the index.'),
  match: z.array(String).default([]).description('Glob patterns over capability names; the first matching family wins.'),
})

const McpServerObject = z.object({
  name: z.string().required().pattern(/^[A-Za-z0-9_-]{1,32}$/u).description('Server key; entries get ids such as mcp:<name>/<tool>.'),
  enabled: z.boolean().default(true).description('Off: the server is never started and leaves the index.'),
  title: z.string().description('Short title for the index.'),
  description: z.string().description('One or two sentences shown in the index; defaults to the server instructions.'),
  transport: z.union([z.const('stdio'), z.const('streamable-http')]).default('stdio'),
  command: z.string().description('stdio: executable.'),
  args: z.array(String).default([]).description('stdio: arguments.'),
  env: z.dict(String).default({}).description('stdio: extra environment over the credential-scrubbed parent environment.'),
  cwd: z.string().description('stdio: working directory.'),
  url: z.string().description('streamable-http: endpoint URL.'),
  headers: z.dict(String).default({}).description('streamable-http: request headers.'),
  allowTools: z.array(String).default([]).description('Glob allow list over tool names; empty allows all.'),
  denyTools: z.array(String).default([]).description('Glob deny list; wins over allowTools.'),
  families: z.array(FamilyRuleSchema).default([]).description('Curated families; unmatched tools are grouped by name.'),
  idleDisconnectMs: z.number().min(1000).default(300_000).description('Close the connection after this idle time.'),
  callTimeoutMs: z.number().min(1000).default(600_000).description('Per-call timeout.'),
  discoveryTimeoutMs: z.number().min(1000).default(60_000).description('Connect and tools/list timeout.'),
  catalogTtlMs: z.number().min(0).default(86_400_000).description('Refresh the cached tool list in the background after this age.'),
})

/** Schema of one MCP server entry, shared with the `/server` row plugin. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const McpServerSchema: z<any, any> = McpServerObject

const ConfigSchema = z.object({
  enabled: z.boolean().default(true).description('Master switch. Off: no tools, no index, every MCP server stopped.'),
  mcp: z.array(McpServerObject).default([]).description('MCP servers served lazily through the catalog.'),
  skills: z.object({
    enabled: z.boolean().default(true).description('Index the Harness skill catalog.'),
    takeOverCatalog: z.boolean().default(true).description('Replace the native per-session skill catalog (names plus descriptions) with the compact index, keeping a `skill` loader tool.'),
    indexMode: z.union([z.const('brief'), z.const('names')]).default('brief').description('brief: names with a short description; names: names only.'),
    briefChars: z.number().min(20).default(80).description('Character budget of each brief description.'),
    families: z.array(FamilyRuleSchema).default([]),
    allow: z.array(String).default([]),
    deny: z.array(String).default([]),
    extraDirs: z.array(String).default(['~/.claude/skills']).description('Skill directories indexed on top of the Harness catalog. `~`, `{home}`, `{dshHome}` and `{cwd}` expand. A native skill of the same name wins.'),
    extraProjectDirs: z.array(String).default(['.dsh/skills', '.claude/skills', '.agents/skills']).description('Extra skill directories relative to each session working directory.'),
    extraRescanMs: z.number().min(0).default(2_000).description('Minimum time between two scans of the extra skill directories; found skills join the index on the next step.'),
  }).default({}),
  toolNames: z.object({
    search: z.string().default('capability_search'),
    describe: z.string().default('capability_describe'),
    call: z.string().default('capability_call'),
  }).default({}),
  limits: z.object({
    searchLimit: z.number().min(1).default(8),
    maxSearchLimit: z.number().min(1).default(60),
    schemaInlineMaxBytes: z.number().min(256).default(6_000),
    describeMaxChars: z.number().min(1000).default(14_000),
    callResultMaxChars: z.number().min(1000).default(120_000),
  }).default({}),
  cacheDir: z.string().description('Catalog cache directory; defaults to $DSH_HOME/capability-catalog.'),
  discover: z.object({
    enabled: z.boolean().default(true).description('Register the MCP servers that other MCP clients already keep in their configuration files. A configured `mcp` entry, or a server another bundle contributes, keeps the name.'),
    files: z.array(String).default([...DEFAULT_DISCOVERY_FILES]).description('Files read in order; each contributes its `mcpServers` map. `~`, `{home}`, `{dshHome}` and `{cwd}` expand; a missing file is ignored.'),
    include: z.array(String).default([]).description('Glob allow list over discovered server names; empty allows all.'),
    deny: z.array(String).default([]).description('Glob deny list over discovered server names; wins over include.'),
    rescanMs: z.number().min(1000).default(30_000).description('Minimum time between two scans of those files.'),
  }).default({}),
  activation: z.object({
    mode: z.union([z.const('off'), z.const('auto'), z.const('native')]).default('off').description('Native activation: a described MCP tool is also registered on that session as an ordinary tool, called directly from the next step. auto: only on routes that accept mid-conversation tool additions (deepseek-flash), so the prompt cache survives; native: on every route.'),
    maxActive: z.number().min(1).default(32).description('Most natively activated tools per session.'),
    maxSchemaBytes: z.number().min(0).default(0).description('Schemas above this many bytes stay behind capability_call; 0 means no limit.'),
  }).default({}),
})

/** Plugin configuration schema (`config` of the `capability-catalog` row). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: z<any, any> = ConfigSchema

/** Resolved configuration. */
export interface ResolvedConfig {
  enabled: boolean
  mcp: Array<McpServerConfig>
  skills: { enabled: boolean; takeOverCatalog: boolean; indexMode: 'brief' | 'names'; briefChars: number; families: FamilyRule[]; allow: string[]; deny: string[]; extraDirs: string[]; extraProjectDirs: string[]; extraRescanMs: number }
  toolNames: { search: string; describe: string; call: string }
  limits: ToolLimits
  cacheDir?: string
  discover?: McpDiscoveryConfig
  activation?: ActivationConfig
}

function dshHome(): string {
  const value = process.env.DSH_HOME?.trim()
  if (!value) return join(homedir(), '.dsh')
  if (value === '~' || value.startsWith('~/')) return join(homedir(), value.slice(1))
  return value
}

/**
 * Activate the catalog.
 * Declared `async` so Cordis treats it as startup work rather than a constructor.
 * @param rawCtx - plugin context.
 * @param config - resolved configuration.
 */
export async function apply(rawCtx: unknown, config: ResolvedConfig): Promise<void> {
  const ctx = rawCtx as HarnessContext
  if (!config.enabled) {
    // Server rows contributed by other bundles settle as no-ops instead of waiting forever.
    ctx.provide('capabilityCatalogServers', { addMcpServer: async () => async () => undefined } satisfies CapabilityCatalogService)
    // The settings page still loads and explains that the catalog is off.
    const offApi: CatalogRemoteApi = {
      overview: async (sessionId) => ({ enabled: false, sessionId: sessionId ?? null, takeOverSkills: false, servers: [], skills: [], indexChars: 0 }),
      set: async () => { throw new Error('The capability catalog is switched off (enabled: false).') },
    }
    ctx.plugin(CatalogRemote as never, offApi as never)
    return
  }
  const logger = ctx.logger('capability-catalog')
  const catalog = new Catalog()
  ctx.effect(() => () => void catalog.dispose(), 'capability-catalog.dispose')

  const names: MetaToolNames = { ...config.toolNames, skill: 'skill' }
  const skillsService = ctx.get('skills') as HarnessContext['skills']
  const cwdOf = async (agent: HarnessAgent | undefined, signal: AbortSignal): Promise<string | undefined> => {
    // Read when needed: the working-directory service may start after this plugin (DSH 0.2.2 does), and
    // without a cwd every workspace-scoped skill (a project's .claude/skills) is unknown to the skill tool.
    const workingDirectory = ctx.get('workingDirectory') as HarnessContext['workingDirectory']
    if (agent === undefined || workingDirectory === undefined) return undefined
    try {
      return await workingDirectory.ensure(agent, signal)
    } catch {
      return undefined
    }
  }
  const viewFor = async (agent: HarnessAgent | undefined, signal: AbortSignal): Promise<ViewContext> => {
    const cwd = await cwdOf(agent, signal)
    return { ...agent ? { scope: agent, sessionId: agent.id } : {}, ...cwd ? { cwd } : {} }
  }
  const viewOf = (exec: ToolExecutionLike): Promise<ViewContext> => viewFor(exec.agent, exec.signal)

  // Per-capability switches, globally and per session.
  const cacheDir = config.cacheDir || join(dshHome(), 'capability-catalog')
  const toggles = new ToggleStore(join(cacheDir, 'toggles.json'))
  await toggles.load()
  const servers = new Map<string, McpSource>()
  const serverOf = (sourceKey: string) => servers.get(sourceKey.replace(/^mcp:/u, ''))
  catalog.isEnabled = (entry, view) => entry.kind === 'skill'
    ? toggles.enabled('skill', entry.name, view.sessionId)
    : toggles.enabled('server', entry.source.replace(/^mcp:/u, ''), view.sessionId, serverOf(entry.source)?.configuredEnabled ?? true)
  catalog.isSourceEnabled = (source, view) => {
    const server = serverOf(source.key)
    return server === undefined || toggles.enabled('server', server.name, view.sessionId, server.configuredEnabled)
  }

  // MCP sources. A server switched off globally does not start at launch; a session that
  // switches it on discovers and runs it on demand for that session only.
  const startIfEnabled = async (source: McpSource) => {
    if (toggles.globallyEnabled(source.name, source.configuredEnabled)) await source.start()
    else await source.start({ discover: false })
  }
  const addMcpServer = async (server: McpServerConfig): Promise<() => Promise<void>> => {
    if (servers.has(server.name)) throw new Error(`capability-catalog: MCP server "${server.name}" is configured twice`)
    const source = new McpSource(server, cacheDir, logger)
    source.isWanted = (view) => toggles.enabled('server', server.name, view.sessionId, server.enabled)
    const remove = catalog.add(source)
    servers.set(server.name, source)
    const dispose = async () => {
      remove()
      if (servers.get(server.name) === source) servers.delete(server.name)
      await source.dispose()
    }
    await startIfEnabled(source)
    return dispose
  }
  ctx.effect(() => toggles.onChange(() => {
    for (const source of servers.values()) {
      if (!toggles.globallyEnabled(source.name, source.configuredEnabled)) void source.disconnect('switched off')
      else if (!source.discovered) void source.start().catch((error: unknown) => logger.warn(`capability-catalog: starting ${source.key} failed`, error))
    }
  }), 'capability-catalog.toggles')
  // Other bundles contribute servers through `@kirkchinese/dsh-capability-catalog/server` rows.
  ctx.provide('capabilityCatalogServers', { addMcpServer } satisfies CapabilityCatalogService)
  await Promise.all(config.mcp.map((server) => addMcpServer(server)))

  // MCP servers other clients already configured: read their files, register what is new, and
  // drop what a file no longer lists. Explicit configuration always keeps the name.
  const discovery = config.discover
  const discovered = new Map<string, () => Promise<void>>()
  let lastScan = 0
  const syncDiscovered = async (): Promise<void> => {
    if (discovery === undefined || !discovery.enabled) return
    const now = Date.now()
    if (now - lastScan < discovery.rescanMs) return
    lastScan = now
    const found = await scanMcpConfigFiles(discovery)
    for (const problem of found.problems) logger.debug(`capability-catalog: discovery: ${problem}`)
    const wanted = new Map(found.servers.map((server) => [server.name, server]))
    for (const [name, dispose] of [...discovered]) {
      if (wanted.has(name)) continue
      discovered.delete(name)
      logger.info(`capability-catalog: MCP server "${name}" is no longer in the discovery files`)
      await dispose().catch((error: unknown) => logger.warn(`capability-catalog: stopping ${name} failed`, error))
    }
    for (const [name, server] of wanted) {
      if (discovered.has(name) || servers.has(name)) continue
      try {
        discovered.set(name, await addMcpServer(server.config))
        logger.info(`capability-catalog: discovered MCP server "${name}" from ${server.origin}`)
      } catch (error) {
        logger.warn(`capability-catalog: could not register "${name}" from ${server.origin}`, error)
      }
    }
  }
  ctx.effect(() => () => {
    const pending = [...discovered.values()]
    discovered.clear()
    for (const dispose of pending) void dispose().catch(() => undefined)
  }, 'capability-catalog.discovery')

  // Skills.
  const skillTakeover = config.skills.enabled && config.skills.takeOverCatalog && skillsService !== undefined
  let skillSource: SkillSource | undefined
  if (config.skills.enabled && skillsService !== undefined) {
    skillSource = new SkillSource(skillsService, {
      indexMode: config.skills.indexMode,
      briefChars: config.skills.briefChars,
      families: config.skills.families,
      allow: config.skills.allow,
      deny: config.skills.deny,
      // Extra directories are only indexed when this catalog also serves the `skill` tool that
      // can load them; otherwise they would be listed and then fail to load.
      ...skillTakeover ? { extra: { dirs: config.skills.extraDirs, projectDirs: config.skills.extraProjectDirs, rescanMs: config.skills.extraRescanMs } } : {},
    })
    catalog.add(skillSource)
  }

  let activator: Activator | undefined
  const tools = createTools(skillsService, catalog, names, config.limits, viewOf, {
    onDescribed: (entry, exec) => activator?.activate(entry, exec),
    loadSkill: (name, view) => skillSource?.load(name, view) ?? Promise.resolve(undefined),
  })
  const activation: ActivationConfig = config.activation ?? { mode: 'off', maxActive: 32, maxSchemaBytes: 0 }
  // auto mode: whether each agent's current route declares `toolUpdate`, resolved per step.
  const llm = ctx.get('llm') as { resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ toolUpdate?: string }> } | undefined
  const routeCapability = new Map<string, Promise<boolean>>()
  const routeAllows = new Map<string, boolean>()
  const supportsToolUpdate = (provider: string, model: string): Promise<boolean> => {
    const key = `${provider}\u0000${model}`
    let known = routeCapability.get(key)
    if (known === undefined) {
      known = (llm?.resolveModelInfo?.(provider, model) ?? Promise.resolve<{ toolUpdate?: string }>({})).then((info) => info.toolUpdate !== undefined, () => false)
      routeCapability.set(key, known)
    }
    return known
  }
  const routeOf = (agent: HarnessAgent) => {
    const selected = agent.model?.current?.()
    if (selected !== undefined) return selected
    const config = agent.session?.requestHeader?.()?.config
    return config?.provider !== undefined && config.model !== undefined ? { provider: config.provider, model: config.model } : undefined
  }
  const learnRoute = async (agent: HarnessAgent, route = routeOf(agent)) => {
    if (route !== undefined) routeAllows.set(agent.id, await supportsToolUpdate(route.provider, route.model))
  }
  /** Map a native name back to its enabled catalog entry for this agent. */
  const resolveNative = (name: string, sessionId: string) => {
    for (const source of catalog.list()) {
      if (!source.key.startsWith('mcp:')) continue
      for (const entry of source.entries({ sessionId })) {
        if (entry.kind !== 'tool' || nativeToolName(entry) !== name) continue
        const found = catalog.find(entry.id, { sessionId })
        return found !== undefined && !('ambiguous' in found) ? found : undefined
      }
    }
    return undefined
  }
  /** Restore the native tools a session declared in its last request, before its next step. */
  const restoreNative = async (agent: HarnessAgent) => {
    if (activator === undefined) return
    await learnRoute(agent)
    const declared = agent.session?.requestHeader?.()?.tools?.map((tool) => tool.name).filter((name) => name.startsWith('mcp__')) ?? []
    if (declared.length === 0) return
    const restored = activator.restore(agent, declared, (name) => resolveNative(name, agent.id))
    if (restored.length > 0) logger.info(`capability-catalog: restored ${restored.length} native tools for ${agent.id}`)
  }
  if (activation.mode !== 'off') {
    activator = new Activator(activation, tools.run, names.call, (message, error) => logger.warn(message, error), (agent) => routeAllows.get(agent.id) === true)
    ctx.effect(() => () => {
      activator?.dispose()
      activator = undefined
    }, 'capability-catalog.native-activation')
    // Switching a server or the whole catalog off for a session releases its native tools.
    ctx.effect(() => toggles.onChange(() => activator?.prune((id, agentId) => {
      const found = catalog.find(id, { sessionId: agentId })
      return found !== undefined && !('ambiguous' in found)
    })), 'capability-catalog.native-prune')
    ctx.on('agent/pre-step', async (payload: { agent: HarnessAgent; modelSelection?: { provider: string; model: string } }, next: () => Promise<unknown>) => {
      await learnRoute(payload.agent, payload.modelSelection ?? routeOf(payload.agent)).catch(() => undefined)
      return next()
    })
  }
  ctx.tools.register(tools.search)
  ctx.tools.register(tools.describe)
  ctx.tools.register(tools.call)

  // The standing index. It depends only on catalog content and the viewer's switches, so it
  // stays byte-identical across steps while nothing is switched.
  ctx.systemPrompt.section({
    name: 'capability-catalog',
    order: SECTION_ORDER,
    interpolate: false,
    text: (context) => {
      const agent = context.scope as HarnessAgent | undefined
      return catalog.renderIndex(agent ? { scope: agent, sessionId: agent.id } : {}, names, skillTakeover, activator !== undefined && (activation.mode === 'native' || (agent !== undefined && routeAllows.get(agent.id) === true)))
    },
  })

  // Prime an unscoped view so the first prompt of any agent already has an index, then
  // build each agent's own view when it is created, before its first prompt assembly.
  await syncDiscovered().catch((error: unknown) => logger.warn('capability-catalog: MCP discovery failed', error))
  await catalog.refresh({}, AbortSignal.timeout(30_000)).catch((error: unknown) => logger.warn('capability-catalog: initial refresh failed', error))
  ctx.on('agent/created', async ({ agent, signal }: { agent: HarnessAgent; signal?: AbortSignal }) => {
    const effective = signal ?? AbortSignal.timeout(30_000)
    try {
      await catalog.refresh(await viewFor(agent, effective), effective)
    } catch (error) {
      if (!effective.aborted) logger.warn('capability-catalog: agent refresh failed', error)
    }
    await restoreNative(agent).catch((error: unknown) => logger.warn('capability-catalog: restoring native tools failed', error))
  })

  // Refresh per-agent state (skills depend on scope and working directory) before each step.
  ctx.on('agent/pre-step', async (payload: { agent: HarnessAgent; signal: AbortSignal }, next: () => Promise<unknown>) => {
    try {
      // A server added to another client's config file joins the catalog on the next step.
      await syncDiscovered()
      await catalog.refresh(await viewFor(payload.agent, payload.signal), payload.signal)
    } catch (error) {
      if (!payload.signal.aborted) logger.warn('capability-catalog: refresh failed', error)
    }
    return next()
  })

  // Skill takeover: a scoped `skill` tool shadows the native one for each agent, which also
  // stops the native catalog message, while `/name` invocation keeps working.
  if (skillTakeover) {
    const owned = new Map<string, () => void>()
    ctx.effect(() => () => {
      for (const dispose of [...owned.values()]) dispose()
      owned.clear()
    }, 'capability-catalog.skill-shadows')
    const shadow = (agent: HarnessAgent) => {
      const agentCtx = agent.ctx
      if (agentCtx === undefined || owned.has(agent.id)) return
      // Shadow only the native tool: an agent whose preset leaves skills out (a Claude Code subagent with a
      // tools list) gets none. DSH 0.2.2 lets no plugin hide a tool registered on the agent afterwards.
      if (agentCtx.tools.get('skill') === undefined) return
      try {
        const dispose = agentCtx.effect(() => {
          const unregister = agentCtx.tools.register(tools.skill)
          return () => {
            unregister()
            owned.delete(agent.id)
          }
        }, 'capability-catalog.skill')
        owned.set(agent.id, dispose)
      } catch (error) {
        logger.warn(`capability-catalog: could not shadow the skill tool for ${agent.id}`, error)
      }
    }
    ctx.on('agent/created', ({ agent }: { agent: HarnessAgent }) => shadow(agent))
    // A reload (plugin update, HMR) finds agents that are already live; shadow them too, or
    // the native catalog would come back for every open session.
    const liveAgents = ctx.get('agents') as { list(): HarnessAgent[] } | undefined
    for (const agent of liveAgents?.list() ?? []) {
      shadow(agent)
      void viewFor(agent, AbortSignal.timeout(30_000)).then((view) => catalog.refresh(view, AbortSignal.timeout(30_000))).catch(() => undefined)
    }
  }

  // A reload finds live sessions that already hold native tools; keep them declared.
  if (activator !== undefined) {
    const live = ctx.get('agents') as { list(): HarnessAgent[] } | undefined
    for (const agent of live?.list() ?? []) void restoreNative(agent).catch(() => undefined)
  }

  // Settings page and per-session controls.
  const agents = ctx.get('agents') as { get(id: string): HarnessAgent | undefined } | undefined
  const api: CatalogRemoteApi = {
    async overview(sessionId, signal) {
      const agent = sessionId === undefined ? undefined : agents?.get(sessionId)
      const view: ViewContext = agent ? await viewFor(agent, signal) : sessionId ? { sessionId } : {}
      if (agent) await catalog.refresh(view, signal).catch(() => undefined)
      if (agent && activator !== undefined && !routeAllows.has(agent.id)) await learnRoute(agent).catch(() => undefined)
      const sessionLayer = toggles.session(sessionId)
      return {
        enabled: true,
        sessionId: sessionId ?? null,
        takeOverSkills: skillTakeover,
        servers: [...servers.values()].map((source) => ({
          name: source.name,
          title: source.title,
          tools: source.toolCount,
          connected: source.connected,
          problem: source.problem ?? null,
          configured: source.configuredEnabled,
          global: toggles.global().servers[source.name] ?? null,
          session: sessionLayer?.servers[source.name] ?? null,
          effective: toggles.enabled('server', source.name, sessionId, source.configuredEnabled),
        })),
        skills: (skillSource?.entries(view) ?? []).map((entry) => ({
          name: entry.name,
          family: entry.family,
          summary: entry.summary,
          global: toggles.global().skills[entry.name] ?? null,
          session: sessionLayer?.skills[entry.name] ?? null,
          effective: toggles.enabled('skill', entry.name, sessionId),
        })),
        indexChars: catalog.renderIndex(view, names, skillTakeover).length,
        activation: {
          mode: activation.mode,
          applies: agent !== undefined && activator?.applies(agent) === true,
          active: sessionId === undefined ? [] : (activator?.list(sessionId) ?? []).map(({ name, id }) => ({ name, id })),
        },
      }
    },
    async set(request) {
      if (request.kind === 'native') {
        if (request.sessionId === undefined) throw new Error('Releasing a native tool needs a sessionId.')
        activator?.release(request.sessionId, request.name === '*' ? undefined : request.name)
        return
      }
      await toggles.set(request.scope === 'global' ? 'global' : { sessionId: request.sessionId! }, request.kind, request.name, request.value)
    },
  }
  ctx.plugin(CatalogRemote as never, api as never)

  logger.info(`capability-catalog: ${catalog.entries({}).length} entries from ${catalog.list().length} sources`)
}
