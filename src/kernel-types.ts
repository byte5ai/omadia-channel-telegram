/**
 * Narrow structural shims for kernel-internal types the Telegram channel
 * plugin consumes via DI. No value imports from kernel paths — the kernel
 * constructs concrete instances and passes them in through
 * `TelegramChannelPluginDeps`.
 *
 * Substantially smaller than the Teams shim: Telegram does not consume
 * RunTracePayload (no run-trace panel rendering), TopicDetector (deferred —
 * v1 passes history straight to the orchestrator), Adaptive-Card config,
 * or SSO machinery (Telegram has no OBO flow — calendar tools surface
 * `sso_unavailable`).
 *
 * Post-S+7.5 cut: `ChatAgent.chat(…)` returns `SemanticAnswer` from
 * `@omadia/channel-sdk`; ChatTurnResult + DiagramAttachment /
 * FollowUpOption / PendingUserChoice / PendingSlotCard / VerifierResultSummary
 * shims are gone. Structural mirror covers only what Telegram still needs
 * from the kernel: ChatParticipants, TurnContext, ConversationHistory, and
 * the input-side `ChatTurnInput`.
 */
import type {
  FollowUpOption as SdkFollowUpOption,
  OutgoingAttachment,
  OutgoingChoiceCard,
  OutgoingSlotPicker,
  SemanticAnswer,
} from '@omadia/channel-sdk';

export type {
  SdkFollowUpOption as FollowUpOption,
  OutgoingAttachment,
  OutgoingChoiceCard,
  OutgoingSlotPicker,
  SemanticAnswer,
};

// ---------------------------------------------------------------------------
// Participants — mirror of src/services/chatParticipants.ts
// ---------------------------------------------------------------------------

export interface ChatParticipant {
  channelUserId: string;
  aadObjectId: string | null;
  displayName: string;
  email: string | null;
  userPrincipalName: string | null;
}

export type ChatParticipantsProvider = () => Promise<ChatParticipant[]>;

// ---------------------------------------------------------------------------
// Turn context — mirror of src/services/turnContext.ts (structural)
// ---------------------------------------------------------------------------

export interface TurnContextValue {
  turnId: string;
  turnDate: string;
  chatParticipants?: ChatParticipantsProvider;
}

export interface TurnContextModule {
  run<T>(value: TurnContextValue, fn: () => Promise<T>): Promise<T>;
  enter(value: TurnContextValue): void;
  runWithChatParticipants<T>(
    chatParticipants: ChatParticipantsProvider,
    fn: () => Promise<T>,
  ): Promise<T>;
  current(): TurnContextValue | undefined;
  currentTurnId(): string | undefined;
  currentTurnDate(): string;
}

// ---------------------------------------------------------------------------
// Conversation history — mirror of src/services/conversationHistory.ts
// ---------------------------------------------------------------------------

export interface ConversationTurn {
  userMessage: string;
  assistantAnswer: string;
  /** Unix millis of the user message. */
  at: number;
}

export interface PendingTopicDecision {
  userMessage: string;
  askedAt: number;
}

export interface ConversationHistoryStore {
  get(scope: string): ConversationTurn[];
  append(scope: string, turn: ConversationTurn): void;
  resetTurns(scope: string): void;
  markPending(scope: string, pending: PendingTopicDecision): void;
  getPending(scope: string): PendingTopicDecision | undefined;
  clearPending(scope: string): void;
  size(): number;
  clear(): void;
}

// ---------------------------------------------------------------------------
// Chat agent — mirror of ChatAgent + ChatTurnInput
// ---------------------------------------------------------------------------

export interface ChatTurnInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  priorTurns?: Array<{ userMessage: string; assistantAnswer: string }>;
  extraSystemHint?: string;
  freshCheck?: boolean;
  ssoAssertion?: string;
  userTimeZone?: string;
  /**
   * S+7.7+ — inbound attachments. Telegram populates `bytesBase64` for
   * image kinds (after getFile + CDN download), kernel-side orchestrator
   * builds multimodal Anthropic content[] when present.
   */
  attachments?: Array<{
    kind: 'image' | 'file' | 'audio' | 'video';
    url: string;
    mediaType: string;
    name?: string;
    sizeBytes?: number;
    bytesBase64?: string;
  }>;
}

/**
 * Channel-facing chat agent. `chat()` returns the SDK's SemanticAnswer.
 * Telegram doesn't consume `chatStream` (that's HTTP-dev-route territory),
 * so the shim omits it — the concrete kernel class (Orchestrator or
 * VerifierService) still implements both; the structural shim is narrower
 * than the real interface.
 */
export interface ChatAgent {
  chat(input: ChatTurnInput): Promise<SemanticAnswer>;
}

// ---------------------------------------------------------------------------
// MemoryStore — narrow structural mirror of @omadia/plugin-api's
// MemoryStore (virtual-FS API). The Telegram plugin reads/writes pairing
// bindings + group activations as JSON files via this shim, never reaching
// for the kernel/plugin-api type directly. The kernel resolves the concrete
// instance via `ctx.services.get<MemoryStore>('memoryStore')` at activate()
// and passes it in through TelegramChannelPluginDeps.
//
// First channel-side memoryStore consumer — capability spec lives in
// docs/harness-platform/conventions/service-capabilities.md §2.1.
// ---------------------------------------------------------------------------

export interface MemoryEntryShim {
  virtualPath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface MemoryStoreShim {
  list(virtualPath: string): Promise<MemoryEntryShim[]>;
  fileExists(virtualPath: string): Promise<boolean>;
  directoryExists(virtualPath: string): Promise<boolean>;
  readFile(virtualPath: string): Promise<string>;
  createFile(virtualPath: string, content: string): Promise<void>;
  writeFile(virtualPath: string, content: string): Promise<void>;
  delete(virtualPath: string): Promise<void>;
  rename(fromVirtualPath: string, toVirtualPath: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Config — narrow subset the Telegram plugin consumes from kernel `Config`
// ---------------------------------------------------------------------------

/**
 * Currently empty — Telegram has no shared-`.env` knobs the plugin needs.
 * Kept as an explicit shim so widening the kernel `Config` doesn't
 * implicitly widen the Telegram package's surface.
 */
export interface TelegramConfigShim {
  /** Reserved for future use (e.g. default user time zone for the channel). */
  readonly _reserved?: never;
}
