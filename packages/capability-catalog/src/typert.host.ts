/**
 * Handwritten Typert Host contribution for the single Remote endpoint, registered
 * automatically by the Harness Typert loader through the `./typert` export.
 * @module
 */
import { catalogOverviewSchema, catalogRequestDescriptor, catalogRequestSchema } from './remote.js'

function namedSchema<T>(name: string, schema: T) {
  return { name, create: () => schema }
}

export const TYPERT = {
  package: '@kirkchinese/dsh-capability-catalog',
  face: 'host',
  schemas: [
    namedSchema('CatalogRequest', catalogRequestSchema),
    namedSchema('CatalogOverview', catalogOverviewSchema),
  ],
  model: { services: [], events: [], objects: [] },
  invocations: [catalogRequestDescriptor],
} as const

export default TYPERT
