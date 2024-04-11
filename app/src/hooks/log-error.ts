// For more information about this file see https://dove.feathersjs.com/guides/cli/log-error.html
import type { HookContext, NextFunction } from '../declarations'
import { logger } from '../logger'
import { getErrorDetails } from '../shared/errors'

export const logError = async (context: HookContext, next: NextFunction) => {
  try {
    await next()
  } catch (error: unknown) {
    const details = getErrorDetails(error)
    logger.error(details.stack || details.message)

    // Log validation errors if present
    const errWithData = error as { data?: unknown }
    if (errWithData.data) {
      logger.error('Data: %O', errWithData.data)
    }

    throw error
  }
}
