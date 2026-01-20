/**
 * Claude Chat React Client
 *
 * React hooks and utilities for building Claude chat interfaces.
 */

export { useClaude } from './useClaude';
export type {
  UseClaudeOptions,
  UseClaudeReturn,
  ConnectionStatus,
  ChatMessage,
  ToolUseData,
  TodoItem,
  WebSocketMessage,
  ChatPayload,
  SystemPayload,
  ChatState,
} from './types';

// Optional: export schemas for users who want runtime validation
export {
  chatPayloadSchema,
  systemPayloadSchema,
  webSocketMessageSchema,
  toolUseDataSchema,
  todoItemSchema,
  validateChatPayload,
  validateSystemPayload,
  validateWebSocketMessage,
} from './schemas';
