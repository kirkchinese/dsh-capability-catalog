/**
 * Remote surface for the settings page and the per-session controls.
 *
 * One strict `request` endpoint keeps the wire contract small: `overview` reads the
 * catalog as one session sees it, `set` changes one global or session override and
 * returns the new overview.
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'

/** Wire namespace and Cordis service key. */
export const REMOTE_NAMESPACE = 'capabilityCatalog'

export const catalogRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('overview'), sessionId: z.string().min(1).max(200).optional() }),
  z.object({
    action: z.literal('set'),
    scope: z.enum(['global', 'session']),
    sessionId: z.string().min(1).max(200).optional(),
    kind: z.enum(['server', 'skill']),
    name: z.string().min(1).max(200),
    value: z.boolean().nullable(),
  }),
])

const overrideSchema = z.boolean().nullable()

export const catalogOverviewSchema = z.object({
  enabled: z.boolean(),
  sessionId: z.string().nullable(),
  takeOverSkills: z.boolean(),
  servers: z.array(z.object({
    name: z.string(),
    title: z.string(),
    tools: z.number(),
    connected: z.boolean(),
    problem: z.string().nullable(),
    configured: z.boolean(),
    global: overrideSchema,
    session: overrideSchema,
    effective: z.boolean(),
  })),
  skills: z.array(z.object({
    name: z.string(),
    family: z.string(),
    summary: z.string(),
    global: overrideSchema,
    session: overrideSchema,
    effective: z.boolean(),
  })),
  indexChars: z.number(),
})

export type CatalogRequest = z.infer<typeof catalogRequestSchema>
export type CatalogOverview = z.infer<typeof catalogOverviewSchema>

/** What the Remote service needs from the running catalog. */
export interface CatalogRemoteApi {
  overview(sessionId: string | undefined, signal: AbortSignal): Promise<CatalogOverview>
  set(request: Extract<CatalogRequest, { action: 'set' }>): Promise<void>
}

/** Host service exposed to the browser as `ctx.remote.capabilityCatalog`. */
export class CatalogRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly api: CatalogRemoteApi) {
    super(ctx, REMOTE_NAMESPACE)
  }

  /** Validate and execute one request. */
  @Remote('request')
  async request(rawRequest: CatalogRequest, signal: AbortSignal): Promise<CatalogOverview> {
    const request = catalogRequestSchema.parse(rawRequest)
    if (request.action === 'set') {
      if (request.scope === 'session' && request.sessionId === undefined) throw new Error('A session override needs a sessionId.')
      await this.api.set(request)
      return this.api.overview(request.sessionId, signal)
    }
    return this.api.overview(request.sessionId, signal)
  }
}

/** Typert codec whose schema is created lazily, as the official registry expects. */
function strictCodec<T>(typeSymbol: string, schema: T) {
  return { mode: 'strict' as const, typeSymbol, create: () => schema }
}

/** Descriptor shared by the Host contribution; the browser carries a structural copy. */
export const catalogRequestDescriptor = {
  id: '@kirkchinese/dsh-capability-catalog#capabilityCatalog/request',
  service: REMOTE_NAMESPACE,
  namespace: REMOTE_NAMESPACE,
  method: 'request',
  invocation: { kind: 'direct' },
  parameters: [{
    name: 'rawRequest',
    wire: 'rawRequest',
    source: 'json',
    codec: strictCodec('@kirkchinese/dsh-capability-catalog#CatalogRequest', catalogRequestSchema),
  }],
  cancellation: { parameter: 'signal' },
  result: strictCodec('@kirkchinese/dsh-capability-catalog#CatalogOverview', catalogOverviewSchema),
  sourceLocation: { file: 'src/remote.ts', line: 1, column: 1 },
} as const
