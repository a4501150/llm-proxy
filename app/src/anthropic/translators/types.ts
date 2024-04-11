import express from 'express'

export interface MessagesTranslator {
  name: string
  executeRequest(body: Record<string, unknown>, res: express.Response, requestId: string): Promise<void>
  executeStreamRequest(body: Record<string, unknown>, res: express.Response, requestId: string): Promise<void>
}
