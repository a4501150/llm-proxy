/**
 * Test setup and configuration
 * This file is loaded before tests run via mocha's require
 */

import * as chai from 'chai'

// Configure chai - chai v5 uses named exports
export const { expect } = chai

// Ensure clean test environment
process.env.NODE_ENV = 'test'
