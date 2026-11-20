/**
 * Shared test doubles: an in-memory memory store and a recording Bot API.
 */
import {
  PairingStore,
  PairingTokenRegistry,
  TelegramBot,
  type EmissionRecord,
  type TelegramApiClient,
  type TelegramBotOptions,
  type TelegramUpdate,
} from '@omadia/channel-telegram';
import type { SemanticAnswer } from '@omadia/channel-sdk';

export type MemoryStoreLike = ConstructorParameters<typeof PairingStore>[0];

export function memoryStore(files: Map<string, string> = new Map()): MemoryStoreLike {
  return {
    list: async () => [],
    fileExists: async (p: string) => files.has(p),
    directoryExists: async () => true,
    readFile: async (p: string) => files.get(p) ?? '',
    createFile: async (p: string, c: string) => void files.set(p, c),
    writeFile: async (p: string, c: string) => void files.set(p, c),
    delete: async (p: string) => void files.delete(p),
    rename: async () => undefined,
  };
}

export interface SentCall {
  readonly method: 'sendMessage' | 'sendPhoto' | 'sendDocument';
  readonly params: Record<string, unknown>;
}

export interface RecordingApi {
  readonly client: TelegramApiClient;
  readonly sent: SentCall[];
  readonly actions: string[];
  readonly callbackAnswers: Array<Record<string, unknown>>;
}

export function recordingApi(): RecordingApi {
  const sent: SentCall[] = [];
  const actions: string[] = [];
  const callbackAnswers: Array<Record<string, unknown>> = [];
  const record =
    (method: SentCall['method']) =>
    async (params: Record<string, unknown>) => {
      sent.push({ method, params });
      return { message_id: sent.length };
    };
  const client = {
    sendMessage: record('sendMessage'),
    sendPhoto: record('sendPhoto'),
    sendDocument: record('sendDocument'),
    sendChatAction: async (p: { action: string }) => {
      actions.push(p.action);
      return true;
    },
    answerCallbackQuery: async (p: Record<string, unknown>) => {
      callbackAnswers.push(p);
      return true;
    },
  } as unknown as TelegramApiClient;
  return { client, sent, actions, callbackAnswers };
}

export const BOT_ID = 999;
export const BOT_USERNAME = 'ColleagueBot';

export interface ChatInput {
  userMessage: string;
  sessionScope?: string;
  userId?: string;
  origin?: { principal?: unknown; conversationType?: string; channelConversationId?: string; messageId?: string; speaker?: unknown };
}

export interface Harness {
  readonly bot: TelegramBot;
  readonly api: RecordingApi;
  readonly emissions: EmissionRecord[];
  readonly turns: ChatInput[];
  readonly pairingStore: PairingStore;
  /** Queue the answers the fake chat agent returns, one per turn. */
  readonly answers: SemanticAnswer[];
}

export function harness(overrides: Partial<TelegramBotOptions> = {}, files?: Map<string, string>): Harness {
  const api = recordingApi();
  const emissions: EmissionRecord[] = [];
  const turns: ChatInput[] = [];
  const answers: SemanticAnswer[] = [];
  const store = memoryStore(files);
  const pairingStore = new PairingStore(store);
  const history = new Map<string, unknown[]>();
  const bot = new TelegramBot({
    api: api.client,
    chatAgent: {
      chat: async (input: ChatInput) => {
        turns.push(input);
        return answers.shift() ?? { text: 'ok', speaker: speakerA };
      },
    },
    history: {
      get: (scope: string) => (history.get(scope) ?? []) as never,
      append: (scope: string, turn: unknown) => void history.set(scope, [...(history.get(scope) ?? []), turn]),
      resetTurns: () => undefined,
      markPending: () => undefined,
      getPending: () => undefined,
      clearPending: () => undefined,
      size: () => history.size,
      clear: () => history.clear(),
    },
    turnContext: {
      runWithChatParticipants: async (_p: unknown, fn: () => Promise<unknown>) => await fn(),
    } as never,
    pairingStore,
    pairingTokens: new PairingTokenRegistry(),
    dmPolicy: 'open',
    botIdentity: { id: BOT_ID, username: BOT_USERNAME },
    onEmit: (r) => void emissions.push(r),
    ...overrides,
  } as TelegramBotOptions);
  return { bot, api, emissions, turns, pairingStore, answers };
}

let updateId = 1;

export function privateText(text: string, fromId = 1): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: `User${String(fromId)}` },
      chat: { id: fromId, type: 'private' },
      date: 0,
      text,
    },
  };
}

export function groupText(text: string, chatId: number, fromId: number, withBotCommand = false): TelegramUpdate {
  const commandEnd = text.indexOf(' ') === -1 ? text.length : text.indexOf(' ');
  return {
    update_id: updateId++,
    message: {
      message_id: updateId,
      from: { id: fromId, is_bot: false, first_name: `User${String(fromId)}` },
      chat: { id: chatId, type: 'supergroup', title: 'Team' },
      date: 0,
      text,
      ...(withBotCommand ? { entities: [{ type: 'bot_command', offset: 0, length: commandEnd }] } : {}),
      ...(text.startsWith('@') ? { entities: [{ type: 'mention', offset: 0, length: commandEnd }] } : {}),
    },
  };
}

export const speakerA = { kind: 'agent', agentId: 'agent-a', slug: 'mira', displayName: 'Mira' } as const;
export const speakerB = { kind: 'agent', agentId: 'agent-b', slug: 'ben', displayName: 'Ben' } as const;

export interface RouteCall {
  readonly type: string;
  readonly key: string;
  readonly context: { principal?: string; locale?: string; explicitSlug?: string } | undefined;
}

/**
 * A fake `channelResolver@1`: `decide` answers per channel key. Records every
 * lookup so a test can read which keys and which principal the bot sent.
 */
export function fakeResolver(
  decide: (key: string) => Record<string, unknown>,
): { readonly lookup: () => { resolve: (...a: never[]) => unknown }; readonly calls: RouteCall[] } {
  const calls: RouteCall[] = [];
  const resolver = {
    resolve: (type: string, key: string, context?: RouteCall['context']) => {
      calls.push({ type, key, context });
      return decide(key);
    },
  };
  return { lookup: () => resolver as never, calls };
}
