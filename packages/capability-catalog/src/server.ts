/**
 * Row plugin that adds one MCP server to the capability catalog.
 *
 * Bundles insert one row per server, so they never overwrite the main catalog row's
 * configuration:
 *
 * ```yaml
 * - insert:
 *     - id: capability-catalog-rea
 *       name: '@kirkchinese/dsh-capability-catalog/server'
 *       config: { name: rea, command: rea, args: [mcp] }
 * ```
 * @module @kirkchinese/dsh-capability-catalog/server
 */
import type { CapabilityCatalogService } from './index.js'
import { McpServerSchema } from './index.js'
import type { McpServerConfig } from './sources/mcp.js'
import type { HarnessContext } from './types.js'

export const name = 'capability-catalog-server'
export const inject = ['capabilityCatalog']
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Config: any = McpServerSchema

/**
 * Register the configured server while this row is active.
 * @param rawCtx - row context with the catalog service.
 * @param config - resolved server configuration.
 */
export async function apply(rawCtx: unknown, config: McpServerConfig): Promise<void> {
  const ctx = rawCtx as HarnessContext & { capabilityCatalog: CapabilityCatalogService }
  let dispose: (() => Promise<void>) | undefined
  let disposed = false
  ctx.effect(() => () => {
    disposed = true
    void dispose?.()
  }, `capability-catalog.server(${config.name})`)
  const remove = await ctx.capabilityCatalog.addMcpServer(config)
  if (disposed) await remove()
  else dispose = remove
}
