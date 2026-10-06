import type { VertexConfig } from '../declarations.js'

/** Homepage/API view state: user secrets are always masked. */
export interface PublicState {
  users: { username: string; maskedSecret: string }[]
  vertex: VertexConfig
  logging: { level: string; logBodies: boolean }
}
