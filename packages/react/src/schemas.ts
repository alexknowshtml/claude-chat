/**
 * Zod Schemas for Runtime Validation
 *
 * Provides runtime validation for WebSocket messages to catch
 * protocol errors and malformed data early.
 */

import { z } from 'zod';

// =============================================================================
// Tool and Todo Schemas
// =============================================================================

export const toolUseDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  friendly: z.string().optional(),
  input: z.record(z.unknown()).optional(),
  inputDetail: z.string().optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  summary: z.string().optional(),
  duration: z.number().optional(),
  startTime: z.number().optional(),
});

export const todoItemSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().optional(),
});

// =============================================================================
// Chat Payload Schema
// =============================================================================

export const chatActionSchema = z.enum([
  'send',
  'token',
  'complete',
  'error',
  'cancel',
  'tool_start',
  'tool_end',
  'thinking',
  'todo_update',
]);

export const chatPayloadSchema = z.object({
  action: chatActionSchema,
  content: z.string().optional(),
  tool: toolUseDataSchema.optional(),
  todos: z.array(todoItemSchema).optional(),
  error: z.string().optional(),
});

// =============================================================================
// System Payload Schema
// =============================================================================

export const systemActionSchema = z.enum([
  'connected',
  'catch_up',
  'snapshot',
  'subscribe',
  'error',
]);

export const chatStateSchema = z.object({
  status: z.enum(['idle', 'streaming', 'complete', 'error']),
  accumulatedContent: z.string(),
  tools: z.array(toolUseDataSchema),
  todos: z.array(todoItemSchema).nullable(),
  errorMessage: z.string().optional(),
});

// WebSocketMessage schema for events array (forward reference handled via lazy)
const webSocketMessageBaseSchema = z.object({
  type: z.enum(['chat', 'system']),
  seq: z.number(),
  timestamp: z.number(),
  sessionId: z.string().optional(),
});

export const systemPayloadSchema = z.object({
  action: systemActionSchema,
  sessionId: z.string().optional(),
  lastSeq: z.number().optional(),
  currentSeq: z.number().optional(),
  events: z.array(z.lazy(() => webSocketMessageSchema)).optional(),
  chatState: chatStateSchema.optional(),
  error: z.string().optional(),
});

// =============================================================================
// WebSocket Message Schema
// =============================================================================

export const webSocketMessageSchema = webSocketMessageBaseSchema.extend({
  payload: z.union([chatPayloadSchema, systemPayloadSchema, z.unknown()]),
});

// =============================================================================
// Type Exports (inferred from schemas)
// =============================================================================

export type ValidatedChatPayload = z.infer<typeof chatPayloadSchema>;
export type ValidatedSystemPayload = z.infer<typeof systemPayloadSchema>;
export type ValidatedWebSocketMessage = z.infer<typeof webSocketMessageSchema>;

// =============================================================================
// Validation Functions
// =============================================================================

/**
 * Validate a chat payload. Returns the validated payload or null if invalid.
 * Logs validation errors to console for debugging.
 */
export function validateChatPayload(data: unknown): ValidatedChatPayload | null {
  const result = chatPayloadSchema.safeParse(data);
  if (!result.success) {
    console.warn('[useClaude] Invalid chat payload:', result.error.format());
    return null;
  }
  return result.data;
}

/**
 * Validate a system payload. Returns the validated payload or null if invalid.
 * Logs validation errors to console for debugging.
 */
export function validateSystemPayload(data: unknown): ValidatedSystemPayload | null {
  const result = systemPayloadSchema.safeParse(data);
  if (!result.success) {
    console.warn('[useClaude] Invalid system payload:', result.error.format());
    return null;
  }
  return result.data;
}

/**
 * Validate a WebSocket message. Returns the validated message or null if invalid.
 * Logs validation errors to console for debugging.
 */
export function validateWebSocketMessage(data: unknown): ValidatedWebSocketMessage | null {
  const result = webSocketMessageSchema.safeParse(data);
  if (!result.success) {
    console.warn('[useClaude] Invalid WebSocket message:', result.error.format());
    return null;
  }
  return result.data;
}
