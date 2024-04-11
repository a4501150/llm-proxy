/**
 * Typed error handling utilities
 * Provides type-safe error extraction to replace 'err: any' casts
 */

/**
 * Interface for provider/API errors with optional structured fields
 */
export interface ProviderError extends Error {
  status?: number
  statusCode?: number
  error?: {
    type?: string
    message?: string
  }
}

/**
 * Type guard to check if an unknown value is an Error
 */
export function isError(err: unknown): err is Error {
  return err instanceof Error
}

/**
 * Type guard to check if an error is a ProviderError with status
 */
export function isProviderError(err: unknown): err is ProviderError {
  return isError(err)
}

/**
 * Extracted error details with all optional fields safely handled
 */
export interface ErrorDetails {
  message: string
  status?: number
  errorType?: string
  errorMessage?: string
  stack?: string
}

/**
 * Safely extract error details from an unknown error value
 * Handles Error objects, ProviderError objects, and arbitrary values
 */
export function getErrorDetails(err: unknown): ErrorDetails {
  if (!isError(err)) {
    return {
      message: String(err)
    }
  }

  const providerErr = err as ProviderError
  return {
    message: providerErr.message,
    status: providerErr.status ?? providerErr.statusCode,
    errorType: providerErr.error?.type,
    errorMessage: providerErr.error?.message,
    stack: providerErr.stack
  }
}

/**
 * Check if an error has a specific HTTP status code
 */
export function hasStatus(err: unknown, status: number): boolean {
  if (!isProviderError(err)) {
    return false
  }
  return err.status === status || err.statusCode === status
}

/**
 * Check if an error is a 404 Not Found
 */
export function isNotFoundError(err: unknown): boolean {
  return hasStatus(err, 404)
}
