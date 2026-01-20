/**
 * useClaude React Hook
 *
 * A React hook for connecting to and interacting with a Claude chat server.
 *
 * Usage:
 * ```tsx
 * import { useClaude } from '@anthropic/claude-chat-react';
 *
 * function Chat() {
 *   const {
 *     messages,
 *     streamingContent,
 *     isStreaming,
 *     send,
 *     cancel,
 *   } = useClaude({ url: 'ws://localhost:3000/ws' });
 *
 *   return (
 *     <div>
 *       {messages.map(m => <Message key={m.id} {...m} />)}
 *       {isStreaming && <div>{streamingContent}</div>}
 *       <input onSubmit={(e) => send(e.target.value)} />
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  UseClaudeOptions,
  UseClaudeReturn,
  ConnectionStatus,
  ChatMessage,
  ContentBlock,
  ToolUseData,
  TodoItem,
  WebSocketMessage,
  ChatPayload,
  SystemPayload,
  ChatAction,
  SystemAction,
} from './types';
import {
  validateChatPayload,
  validateSystemPayload,
} from './schemas';

// =============================================================================
// Module-level WebSocket Singleton (survives React StrictMode remounts)
// Pattern ported from Andy Core's useWebSocketConnection.ts
// =============================================================================

const RECONNECT_DELAY = 2000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Singleton WebSocket state per URL
interface SharedWebSocketState {
  ws: WebSocket | null;
  connecting: boolean;
  reconnectTimeout: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  subscribedSession: string | null;
  // Listener Sets - all hook instances register their handlers here
  messageListeners: Set<(event: MessageEvent) => void>;
  connectionListeners: Set<(connected: boolean, reconnecting: boolean) => void>;
  openListeners: Set<() => void>;
}

// Track shared state per URL
const sharedStates = new Map<string, SharedWebSocketState>();

/**
 * Get or create shared state for a URL.
 */
function getSharedState(url: string): SharedWebSocketState {
  let state = sharedStates.get(url);
  if (!state) {
    state = {
      ws: null,
      connecting: false,
      reconnectTimeout: null,
      reconnectAttempts: 0,
      subscribedSession: null,
      messageListeners: new Set(),
      connectionListeners: new Set(),
      openListeners: new Set(),
    };
    sharedStates.set(url, state);
  }
  return state;
}

/**
 * Create the shared WebSocket connection (called by first hook that needs it).
 */
function createSharedWebSocket(url: string, onConnect?: () => void): void {
  const state = getSharedState(url);

  // Already open
  if (state.ws?.readyState === WebSocket.OPEN) {
    console.log('[WS] Shared connection already open');
    onConnect?.();
    return;
  }
  // Already connecting
  if (state.ws?.readyState === WebSocket.CONNECTING) {
    console.log('[WS] Shared connection already connecting');
    if (onConnect) {
      state.openListeners.add(onConnect);
    }
    return;
  }
  // Connection in progress (flag)
  if (state.connecting) {
    console.log('[WS] Shared connection in progress (flag)');
    if (onConnect) {
      state.openListeners.add(onConnect);
    }
    return;
  }

  state.connecting = true;
  if (onConnect) {
    state.openListeners.add(onConnect);
  }
  console.log('[WS] Creating shared connection to:', url);

  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => {
    console.log('[WS] Shared connection opened');
    state.connecting = false;
    state.reconnectAttempts = 0;
    // Notify all connection listeners
    state.connectionListeners.forEach(listener => listener(true, false));
    // Call and clear open listeners
    state.openListeners.forEach(listener => listener());
    state.openListeners.clear();
  };

  ws.onmessage = (event) => {
    // Broadcast to all registered message listeners
    state.messageListeners.forEach(listener => listener(event));
  };

  ws.onerror = (error) => {
    console.error('[WS] Shared connection error:', error);
    state.connecting = false;
  };

  ws.onclose = () => {
    console.log('[WS] Shared connection closed');
    state.ws = null;
    state.connecting = false;
    state.subscribedSession = null;

    // Notify all connection listeners
    const isReconnecting = state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS;
    state.connectionListeners.forEach(listener => listener(false, isReconnecting));

    // Schedule reconnect if there are still listeners
    if (state.messageListeners.size > 0 && state.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      state.reconnectAttempts++;
      const delay = RECONNECT_DELAY * Math.min(state.reconnectAttempts, 5);
      console.log(`[WS] Scheduling shared reconnect in ${delay}ms (attempt ${state.reconnectAttempts})`);

      state.reconnectTimeout = setTimeout(() => {
        state.reconnectTimeout = null;
        if (state.messageListeners.size > 0) {
          createSharedWebSocket(url);
        }
      }, delay);
    }
  };
}

/**
 * Close the shared WebSocket connection for a URL.
 */
function closeSharedWebSocket(url: string): void {
  const state = sharedStates.get(url);
  if (!state) return;

  if (state.reconnectTimeout) {
    clearTimeout(state.reconnectTimeout);
    state.reconnectTimeout = null;
  }
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  state.connecting = false;
  state.reconnectAttempts = 0;
  state.subscribedSession = null;
}

/**
 * Register a message listener for a URL.
 * Returns a cleanup function to unregister.
 */
function registerMessageListener(url: string, listener: (event: MessageEvent) => void): () => void {
  const state = getSharedState(url);
  state.messageListeners.add(listener);
  return () => {
    state.messageListeners.delete(listener);
    // If no more listeners, close the connection
    if (state.messageListeners.size === 0) {
      closeSharedWebSocket(url);
    }
  };
}

/**
 * Register a connection status listener for a URL.
 * Returns a cleanup function to unregister.
 */
function registerConnectionListener(url: string, listener: (connected: boolean, reconnecting: boolean) => void): () => void {
  const state = getSharedState(url);
  state.connectionListeners.add(listener);
  return () => {
    state.connectionListeners.delete(listener);
  };
}

/**
 * Send a message via the shared WebSocket.
 */
function sendViaSharedWebSocket(url: string, data: string): boolean {
  const state = sharedStates.get(url);
  if (state?.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(data);
    return true;
  }
  return false;
}

/**
 * Check if shared WebSocket is connected.
 */
function isSharedWebSocketConnected(url: string): boolean {
  const state = sharedStates.get(url);
  return state?.ws?.readyState === WebSocket.OPEN;
}

// =============================================================================
// Internal Types for Handler Functions
// =============================================================================

/**
 * Refs needed by chat message handlers.
 */
interface StreamingRefs {
  streamingContent: React.MutableRefObject<string>;
  completedTools: React.MutableRefObject<ToolUseData[]>;
  isStreaming: React.MutableRefObject<boolean>;
  contentBlocks: React.MutableRefObject<ContentBlock[]>;
  pendingText: React.MutableRefObject<string>;
  currentToolGroup: React.MutableRefObject<ToolUseData[]>;
  currentAssistantMessage: React.MutableRefObject<string | null>;
  lastSeq: React.MutableRefObject<number>;
}

/**
 * State setters needed by chat message handlers.
 */
interface StateSetters {
  setStreamingContent: React.Dispatch<React.SetStateAction<string>>;
  setActiveTools: React.Dispatch<React.SetStateAction<ToolUseData[]>>;
  setCompletedTools: React.Dispatch<React.SetStateAction<ToolUseData[]>>;
  setTodos: React.Dispatch<React.SetStateAction<TodoItem[] | null>>;
  setIsStreaming: React.Dispatch<React.SetStateAction<boolean>>;
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setSessionId: React.Dispatch<React.SetStateAction<string | null>>;
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Helper for exhaustive switch statements.
 * TypeScript will error if a case is missed.
 */
function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

/**
 * Generate a unique message ID.
 */
function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}

// =============================================================================
// Chat Action Handlers
// =============================================================================

/**
 * Handle 'token' action - accumulate streaming text content.
 */
function handleTokenAction(
  payload: ChatPayload,
  refs: StreamingRefs,
  setters: StateSetters
): void {
  if (!payload.content) return;

  refs.pendingText.current += payload.content;
  setters.setStreamingContent((prev) => {
    const newContent = prev + payload.content;
    refs.streamingContent.current = newContent;
    return newContent;
  });
}

/**
 * Handle 'tool_start' action - track a new tool beginning execution.
 */
function handleToolStartAction(
  payload: ChatPayload,
  refs: StreamingRefs,
  setters: StateSetters
): void {
  if (!payload.tool) return;

  // If we have pending text, flush it as a text block before starting tools
  if (refs.pendingText.current.trim()) {
    refs.contentBlocks.current = [
      ...refs.contentBlocks.current,
      { type: 'text', content: refs.pendingText.current, timestamp: Date.now() },
    ];
    refs.pendingText.current = '';
  }

  // Add tool to current tool group (deduplicated)
  if (!refs.currentToolGroup.current.some((t) => t.id === payload.tool!.id)) {
    refs.currentToolGroup.current = [...refs.currentToolGroup.current, payload.tool];
  }

  setters.setActiveTools((prev) => {
    // Deduplicate - don't add if tool with this ID already exists
    if (prev.some((t) => t.id === payload.tool!.id)) {
      return prev;
    }
    return [...prev, payload.tool!];
  });
}

/**
 * Handle 'tool_end' action - mark a tool as completed.
 */
function handleToolEndAction(
  payload: ChatPayload,
  refs: StreamingRefs,
  setters: StateSetters
): void {
  if (!payload.tool) return;

  // Update the tool in current tool group with completion data
  refs.currentToolGroup.current = refs.currentToolGroup.current.map((t) =>
    t.id === payload.tool!.id ? { ...t, ...payload.tool } : t
  );

  setters.setActiveTools((prev) => {
    const filtered = prev.filter((t) => t.id !== payload.tool!.id);

    // If no more active tools, flush the tool group as a content block
    if (filtered.length === 0 && refs.currentToolGroup.current.length > 0) {
      refs.contentBlocks.current = [
        ...refs.contentBlocks.current,
        { type: 'tool_group', tools: [...refs.currentToolGroup.current], timestamp: Date.now() },
      ];
      refs.currentToolGroup.current = [];
    }

    return filtered;
  });

  setters.setCompletedTools((prev) => {
    // Deduplicate - don't add if tool with this ID already exists
    if (prev.some((t) => t.id === payload.tool!.id)) {
      return prev;
    }
    const newTools = [...prev, payload.tool!];
    refs.completedTools.current = newTools;
    return newTools;
  });
}

/**
 * Handle 'todo_update' action - update the todo list display.
 */
function handleTodoUpdateAction(
  payload: ChatPayload,
  setters: StateSetters
): void {
  if (payload.todos) {
    setters.setTodos(payload.todos);
  }
}

/**
 * Reset all streaming state to initial values.
 */
function resetStreamingState(
  refs: StreamingRefs,
  setters: StateSetters
): void {
  setters.setStreamingContent('');
  refs.streamingContent.current = '';
  setters.setActiveTools([]);
  setters.setCompletedTools([]);
  refs.completedTools.current = [];
  refs.contentBlocks.current = [];
  refs.pendingText.current = '';
  refs.currentToolGroup.current = [];
  refs.currentAssistantMessage.current = null;
}

/**
 * Handle 'complete' action - finalize the assistant message.
 */
function handleCompleteAction(
  refs: StreamingRefs,
  setters: StateSetters
): void {
  // Mark streaming as finished
  setters.setIsStreaming(false);
  refs.isStreaming.current = false;

  // Flush any remaining pending text as a final content block
  if (refs.pendingText.current.trim()) {
    refs.contentBlocks.current = [
      ...refs.contentBlocks.current,
      { type: 'text', content: refs.pendingText.current, timestamp: Date.now() },
    ];
    refs.pendingText.current = '';
  }

  // Flush any remaining tool group (shouldn't happen, but be safe)
  if (refs.currentToolGroup.current.length > 0) {
    refs.contentBlocks.current = [
      ...refs.contentBlocks.current,
      { type: 'tool_group', tools: [...refs.currentToolGroup.current], timestamp: Date.now() },
    ];
    refs.currentToolGroup.current = [];
  }

  // Capture final values from refs (avoids stale closure)
  const finalContent = refs.streamingContent.current;
  const finalTools = [...refs.completedTools.current];
  const finalContentBlocks = [...refs.contentBlocks.current];
  const currentMsgId = refs.currentAssistantMessage.current;

  setters.setMessages((prev) => {
    // Find the streaming message by ID first, fallback to finding any streaming message
    let streamingIdx = prev.findIndex((m) => m.id === currentMsgId);

    // Fallback: find any message that's still streaming
    if (streamingIdx < 0) {
      streamingIdx = prev.findIndex((m) => m.isStreaming);
    }

    if (streamingIdx >= 0) {
      const updated = [...prev];
      updated[streamingIdx] = {
        ...updated[streamingIdx],
        content: finalContent,
        tools: finalTools,
        contentBlocks: finalContentBlocks,
        isStreaming: false,
      };
      return updated;
    }

    // Only add a new message if we truly don't have one
    // This should rarely happen
    if (finalContent || finalTools.length > 0 || finalContentBlocks.length > 0) {
      return [
        ...prev,
        {
          id: generateId(),
          role: 'assistant' as const,
          content: finalContent,
          timestamp: Date.now(),
          tools: finalTools,
          contentBlocks: finalContentBlocks,
          isStreaming: false,
        },
      ];
    }

    return prev;
  });

  // Reset streaming state
  resetStreamingState(refs, setters);
}

/**
 * Handle 'error' action - set error state and reset streaming.
 */
function handleErrorAction(
  payload: ChatPayload,
  refs: StreamingRefs,
  setters: StateSetters,
  onError?: (error: string) => void
): void {
  setters.setIsStreaming(false);
  refs.isStreaming.current = false;
  setters.setError(payload.error || 'Unknown error');
  onError?.(payload.error || 'Unknown error');

  // Reset streaming state
  resetStreamingState(refs, setters);
}

/**
 * Route a chat payload to the appropriate handler.
 */
function handleChatPayload(
  payload: ChatPayload,
  refs: StreamingRefs,
  setters: StateSetters,
  onError?: (error: string) => void
): void {
  const action: ChatAction = payload.action;

  switch (action) {
    case 'token':
      handleTokenAction(payload, refs, setters);
      break;

    case 'tool_start':
      handleToolStartAction(payload, refs, setters);
      break;

    case 'tool_end':
      handleToolEndAction(payload, refs, setters);
      break;

    case 'todo_update':
      handleTodoUpdateAction(payload, setters);
      break;

    case 'thinking':
      // Could show a thinking indicator - currently no-op
      break;

    case 'complete':
      handleCompleteAction(refs, setters);
      break;

    case 'error':
      handleErrorAction(payload, refs, setters, onError);
      break;

    case 'send':
    case 'cancel':
      // These are outbound-only actions, shouldn't be received
      break;

    default:
      // TypeScript exhaustive check - will error if a ChatAction is missed
      assertNever(action);
  }
}

// =============================================================================
// System Action Handlers
// =============================================================================

/**
 * Handle 'connected' system action.
 */
function handleConnectedAction(
  payload: SystemPayload,
  refs: StreamingRefs
): void {
  if (payload.currentSeq) {
    refs.lastSeq.current = payload.currentSeq;
  }
}

/**
 * Handle 'snapshot' system action - restore session state.
 */
function handleSnapshotAction(
  payload: SystemPayload,
  refs: StreamingRefs,
  setters: StateSetters,
  handleMessage: (event: MessageEvent) => void
): void {
  if (payload.sessionId) {
    setters.setSessionId(payload.sessionId);
  }

  // Replay any missed events
  if (payload.events) {
    for (const event of payload.events) {
      handleMessage({ data: JSON.stringify(event) } as MessageEvent);
    }
  }

  // Restore chat state
  if (payload.chatState) {
    const state = payload.chatState;
    if (state.status === 'streaming') {
      setters.setIsStreaming(true);
      refs.isStreaming.current = true;
      setters.setStreamingContent(state.accumulatedContent);
    }
    if (state.tools) {
      setters.setCompletedTools(state.tools);
    }
    if (state.todos) {
      setters.setTodos(state.todos);
    }
  }
}

/**
 * Handle system 'error' action.
 */
function handleSystemErrorAction(
  payload: SystemPayload,
  setters: StateSetters,
  onError?: (error: string) => void
): void {
  setters.setError(payload.error || 'System error');
  onError?.(payload.error || 'System error');
}

/**
 * Route a system payload to the appropriate handler.
 */
function handleSystemPayload(
  payload: SystemPayload,
  refs: StreamingRefs,
  setters: StateSetters,
  handleMessage: (event: MessageEvent) => void,
  onError?: (error: string) => void
): void {
  const action: SystemAction = payload.action;

  switch (action) {
    case 'connected':
      handleConnectedAction(payload, refs);
      break;

    case 'snapshot':
      handleSnapshotAction(payload, refs, setters, handleMessage);
      break;

    case 'error':
      handleSystemErrorAction(payload, setters, onError);
      break;

    case 'catch_up':
    case 'subscribe':
      // These are outbound-only or handled elsewhere
      break;

    default:
      // TypeScript exhaustive check - will error if a SystemAction is missed
      assertNever(action);
  }
}

/**
 * React hook for Claude chat integration.
 */
export function useClaude(options: UseClaudeOptions): UseClaudeReturn {
  const {
    url,
    sessionId: initialSessionId,
    autoConnect = true,
    autoReconnect = true,
    maxReconnectAttempts = 5,
    reconnectDelay = 2000,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  // Connection state
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId || null);
  const [error, setError] = useState<string | null>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeTools, setActiveTools] = useState<ToolUseData[]>([]);
  const [completedTools, setCompletedTools] = useState<ToolUseData[]>([]);
  const [todos, setTodos] = useState<TodoItem[] | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  // Refs (no longer need wsRef - using shared WebSocket)
  const lastSeqRef = useRef(0);
  const currentAssistantMessageRef = useRef<string | null>(null);
  // Use refs to avoid stale closures in handleMessage
  const streamingContentRef = useRef('');
  const completedToolsRef = useRef<ToolUseData[]>([]);
  const isStreamingRef = useRef(false);
  // Track content blocks for interleaved rendering
  const contentBlocksRef = useRef<ContentBlock[]>([]);
  const pendingTextRef = useRef('');
  const currentToolGroupRef = useRef<ToolUseData[]>([]);

  // Bundle refs for handler functions
  const streamingRefs: StreamingRefs = {
    streamingContent: streamingContentRef,
    completedTools: completedToolsRef,
    isStreaming: isStreamingRef,
    contentBlocks: contentBlocksRef,
    pendingText: pendingTextRef,
    currentToolGroup: currentToolGroupRef,
    currentAssistantMessage: currentAssistantMessageRef,
    lastSeq: lastSeqRef,
  };

  // Bundle setters for handler functions
  const stateSetters: StateSetters = {
    setStreamingContent,
    setActiveTools,
    setCompletedTools,
    setTodos,
    setIsStreaming,
    setMessages,
    setError,
    setSessionId,
  };

  /**
   * Handle incoming WebSocket message.
   * Routes to appropriate handler based on message type.
   * Validates payloads at runtime for type safety.
   */
  const handleMessage = useCallback((event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data) as WebSocketMessage;

      // Update sequence tracking
      if (msg.seq > lastSeqRef.current) {
        lastSeqRef.current = msg.seq;
      }

      if (msg.type === 'chat') {
        // Validate chat payload at runtime
        const payload = validateChatPayload(msg.payload);
        if (!payload) {
          console.error('[useClaude] Received invalid chat payload, skipping');
          return;
        }
        handleChatPayload(payload as ChatPayload, streamingRefs, stateSetters, onError);
      } else if (msg.type === 'system') {
        // Validate system payload at runtime
        const payload = validateSystemPayload(msg.payload);
        if (!payload) {
          console.error('[useClaude] Received invalid system payload, skipping');
          return;
        }
        handleSystemPayload(payload as SystemPayload, streamingRefs, stateSetters, handleMessage, onError);
      }
    } catch (err) {
      console.error('[useClaude] Failed to parse message:', err);
    }
  }, [onError]);

  /**
   * Connect to the WebSocket server.
   * Uses module-level singleton to survive React StrictMode remounts.
   */
  const connect = useCallback(() => {
    // Check if already connected via shared WebSocket
    if (isSharedWebSocketConnected(url)) {
      setStatus('connected');
      return;
    }

    setStatus('connecting');
    setError(null);

    createSharedWebSocket(url, () => {
      // On connect, subscribe to session if we have one
      const state = getSharedState(url);
      if (sessionId && state.ws?.readyState === WebSocket.OPEN) {
        if (state.subscribedSession !== sessionId) {
          console.log('[WS] Auto-subscribing to session:', sessionId);
          state.subscribedSession = sessionId;
          state.ws.send(
            JSON.stringify({
              type: 'system',
              seq: 0,
              timestamp: Date.now(),
              payload: {
                action: 'subscribe',
                sessionId,
              },
            })
          );
        }
      }
    });
  }, [url, sessionId]);

  /**
   * Disconnect from the WebSocket server.
   * Note: This only disconnects this hook instance's interest in the connection.
   * The shared WebSocket stays open if other listeners exist.
   */
  const disconnect = useCallback(() => {
    setStatus('disconnected');
    // The actual WebSocket cleanup happens via the listener cleanup in useEffect
  }, []);

  /**
   * Send a message to Claude.
   */
  const send = useCallback(
    (content: string) => {
      if (!isSharedWebSocketConnected(url)) {
        setError('Not connected');
        return;
      }

      // Prevent double-send while already streaming
      if (isStreamingRef.current) {
        return;
      }

      // Add user message to history
      const userMessage: ChatMessage = {
        id: generateId(),
        role: 'user',
        content,
        timestamp: Date.now(),
      };

      // Prepare for streaming response
      setIsStreaming(true);
      isStreamingRef.current = true;
      setStreamingContent('');
      streamingContentRef.current = '';
      setActiveTools([]);
      setCompletedTools([]);
      completedToolsRef.current = [];
      setError(null);

      // Create placeholder assistant message
      const assistantId = generateId();
      currentAssistantMessageRef.current = assistantId;

      // Add both user and assistant messages in one update to avoid race conditions
      setMessages((prev) => [
        ...prev,
        userMessage,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          isStreaming: true,
        },
      ]);

      // Send the message via shared WebSocket
      sendViaSharedWebSocket(
        url,
        JSON.stringify({
          type: 'chat',
          seq: 0,
          timestamp: Date.now(),
          sessionId,
          payload: {
            action: 'send',
            content,
          },
        })
      );
    },
    [url, sessionId]
  );

  /**
   * Cancel the current streaming response.
   */
  const cancel = useCallback(() => {
    if (!isSharedWebSocketConnected(url)) {
      return;
    }

    sendViaSharedWebSocket(
      url,
      JSON.stringify({
        type: 'chat',
        seq: 0,
        timestamp: Date.now(),
        sessionId,
        payload: {
          action: 'cancel',
        },
      })
    );
  }, [url, sessionId]);

  /**
   * Clear chat history.
   */
  const clearMessages = useCallback(() => {
    setMessages([]);
    setStreamingContent('');
    setActiveTools([]);
    setCompletedTools([]);
    setTodos(null);
    setError(null);
  }, []);

  // Register message and connection listeners with the shared WebSocket.
  // This is the key pattern from Andy Core - listeners survive StrictMode remounts.
  useEffect(() => {
    // Register message listener
    const unregisterMessage = registerMessageListener(url, handleMessage);

    // Register connection listener
    const unregisterConnection = registerConnectionListener(url, (connected, reconnecting) => {
      if (connected) {
        setStatus('connected');
        onConnect?.();
      } else if (reconnecting) {
        setStatus('reconnecting');
      } else {
        setStatus('disconnected');
        onDisconnect?.();
      }
    });

    // Auto-connect after a small delay (helps with iOS Safari)
    let connectTimeoutId: ReturnType<typeof setTimeout> | null = null;
    if (autoConnect) {
      connectTimeoutId = setTimeout(() => {
        connect();
      }, 300);
    }

    // Cleanup: unregister listeners (shared WebSocket closes when no listeners remain)
    return () => {
      if (connectTimeoutId) {
        clearTimeout(connectTimeoutId);
      }
      unregisterMessage();
      unregisterConnection();
    };
  }, [url, autoConnect, handleMessage, onConnect, onDisconnect, connect]);

  // Update streaming message content in real-time
  useEffect(() => {
    if (isStreaming && currentAssistantMessageRef.current) {
      setMessages((prev) => {
        const idx = prev.findIndex(
          (m) => m.id === currentAssistantMessageRef.current
        );
        if (idx >= 0) {
          const updated = [...prev];
          // Build live contentBlocks from refs for real-time rendering
          const liveContentBlocks = [...contentBlocksRef.current];
          // Add pending text if any
          if (pendingTextRef.current.trim()) {
            liveContentBlocks.push({
              type: 'text',
              content: pendingTextRef.current,
              timestamp: Date.now(),
            });
          }
          // Add current tool group if any active tools
          if (currentToolGroupRef.current.length > 0) {
            liveContentBlocks.push({
              type: 'tool_group',
              tools: [...currentToolGroupRef.current],
              timestamp: Date.now(),
            });
          }
          updated[idx] = {
            ...updated[idx],
            content: streamingContent,
            tools: [...activeTools, ...completedTools],
            contentBlocks: liveContentBlocks,
          };
          return updated;
        }
        return prev;
      });
    }
  }, [streamingContent, activeTools, completedTools, isStreaming]);

  return {
    status,
    sessionId,
    messages,
    streamingContent,
    activeTools,
    completedTools,
    todos,
    isStreaming,
    error,
    send,
    cancel,
    connect,
    disconnect,
    clearMessages,
  };
}
