// For more information about this file see https://dove.feathersjs.com/guides/cli/logging.html
import { createLogger, format, transports } from 'winston'

// Custom format for structured logging with timestamps
const customFormat = format.printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level.toUpperCase()}]: ${message}`
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`
  }
  return msg
})

// Configure the Winston logger. For the complete documentation see https://github.com/winstonjs/winston
export const logger = createLogger({
  // Use LOG_LEVEL env var or default to 'info'. Set to 'debug' for detailed logs.
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    format.splat(),
    format.errors({ stack: true }),
    customFormat
  ),
  transports: [new transports.Console()]
})
