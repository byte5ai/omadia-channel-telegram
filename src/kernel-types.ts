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
  Principal,
  ScopeId,
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
  /** `'agent'` marks a bot; the kernel leaves it out of the room's audience. */
  kind?: 'human' | 'agent';
}

/**
 * `completeRoster` asserts the list is everyone in the chat. Only then does
 * the kernel use it as the audience for member-scoped memory.
 */
export type ChatParticipantsProvider = (() => Promise<ChatParticipant[]>) & {
  readonly completeRoster?: boolean;
};

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

/**
 * W5 memory-ACL — structural mirror of the SDK's `TurnOrigin` (design #870 §2).
 *
 * A shim rather than a re-export for the same reason everything else in this
 * file is one: the plugin is versioned independently of the kernel and installs
 * against whatever `@omadia/channel-sdk` a deployment already ships. A named
 * import of `TurnOrigin` would make this package fail to build against every
 * SDK released before the type existed; a structural mirror keeps the object
 * assignable the moment the kernel's `ChatTurnInput.origin` lands, and inert
 * (an ignored extra property) on a kernel that has not learned about it yet.
 *
 * `ScopeId` and `Principal` are named imports because both predate this wave
 * and are already part of the SDK surface this package builds against — the
 * only field that needed mirroring is the envelope.
 *
 * Telegram never fills `container`: the Bot API has no notion of an enclosing
 * workspace. A supergroup is a conversation, not a team, so the field stays
 * absent and such a turn reaches its channel tier only — never a team tier
 * shared with another chat. See `telegramTurnOrigin` in telegramBot.ts.
 */
export interface TurnOriginShim {
  /** Plugin/channel type token. Always `'telegram'` from this package. */
  readonly channelType: string;
  /** Conversation scope of the turn — the existing #575 type. */
  readonly scope: ScopeId;
  /** Enclosing container when the platform supplies one. Telegram: never. */
  readonly container?: { readonly kind: 'team' | 'tenant'; readonly id: string };
  /** Speaking person — the existing #333 type. Audit only, not the axis key. */
  readonly principal?: Principal;
}

export interface ChatTurnInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  /**
   * W5 memory-ACL — where this turn came from, for chat-context memory scoping.
   *
   * Optional by contract: a kernel that predates the memory ACL ignores it, and
   * a turn that arrives without it resolves to the context-free axes, which are
   * byte-identical to today's behaviour. No flag day in either direction.
   */
  origin?: TurnOriginShim;
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
