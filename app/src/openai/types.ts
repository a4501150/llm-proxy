/**
 * OpenAI-compatible Chat Completion API type definitions
 */

// --- Message Content Types ---

export interface OpenAITextContentPart {
  type: 'text'
  text: string
}

export interface OpenAIImageContentPart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: 'auto' | 'low' | 'high'
  }
}

export type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart

// --- Tool/Function Types ---

export interface OpenAIFunctionCall {
  name: string
  arguments: string // JSON string
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: OpenAIFunctionCall
}

export interface OpenAIFunction {
  name: string
  description?: string
  parameters?: Record<string, unknown>
}

export interface OpenAITool {
  type: 'function'
  function: OpenAIFunction
}

export type OpenAIToolChoice = 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } }

// --- Message Types ---

export interface OpenAISystemMessage {
  role: 'system'
  content: string
  name?: string
}

export interface OpenAIUserMessage {
  role: 'user'
  content: string | OpenAIContentPart[]
  name?: string
}

export interface OpenAIAssistantMessage {
  role: 'assistant'
  content: string | null
  name?: string
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIToolMessage {
  role: 'tool'
  content: string
  tool_call_id: string
}

export type OpenAIChatMessage =
  OpenAISystemMessage | OpenAIUserMessage | OpenAIAssistantMessage | OpenAIToolMessage

// --- Request Types ---

export interface OpenAIChatRequest {
  model: string
  messages: OpenAIChatMessage[]
  stream?: boolean
  max_tokens?: number
  temperature?: number
  top_p?: number
  n?: number // Number of completions (only 1 supported)
  stop?: string | string[]
  presence_penalty?: number
  frequency_penalty?: number
  tools?: OpenAITool[]
  tool_choice?: OpenAIToolChoice
  user?: string
}

// --- Response Types ---

export type OpenAIFinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | null

export interface OpenAIChatResponseMessage {
  role: 'assistant'
  content: string | null
  tool_calls?: OpenAIToolCall[]
}

export interface OpenAIChatChoice {
  index: number
  message: OpenAIChatResponseMessage
  finish_reason: OpenAIFinishReason
}

export interface OpenAIUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

export interface OpenAIChatResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: OpenAIChatChoice[]
  usage: OpenAIUsage
}

// --- Streaming Response Types ---

export interface OpenAIDeltaContent {
  role?: 'assistant'
  content?: string
  tool_calls?: OpenAIToolCallDelta[]
}

export interface OpenAIToolCallDelta {
  index: number
  id?: string
  type?: 'function'
  function?: {
    name?: string
    arguments?: string
  }
}

export interface OpenAIChatChunkChoice {
  index: number
  delta: OpenAIDeltaContent
  finish_reason: OpenAIFinishReason
}

export interface OpenAIChatChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: OpenAIChatChunkChoice[]
}

// --- Error Types ---

export interface OpenAIErrorResponse {
  error: {
    message: string
    type: 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'server_error'
    param?: string | null
    code?: string | null
  }
}
