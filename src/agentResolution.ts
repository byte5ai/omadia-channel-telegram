/**
 * Which agent answers a Telegram turn (S1 contract, spec 2042 §5.3, INV-7).
 *
 * The kernel's `channelResolver@1` answers with `bound` (the turn belongs to
 * this agent, `speaker` known before the answer) or `reject` (no agent
 * answers; `notice` says why). `chatAgent` is set on both: on `reject` it still
 * carries out `/agent`, `/agents` and answers anything else from `system`.
 * There is no fallback agent. The channel only passes the text through.
 */

import type {
  AgentSpeaker,
  ChannelResolveResult,
  ChannelRouteContext,
  SystemNotice,
} from '@omadia/channel-sdk';

import type { ChatAgent } from './kernel-types.js';

/** The `channel_bindings.channel_type` of this channel. */
const CHANNEL_TYPE = 'telegram';

/** What the resolver made of a turn. */
export type AgentResolution =
  | {
      readonly kind: 'agent';
      readonly agent: ChatAgent;
      /** The agent that will answer, known before the answer (the pace acknowledgement speaks as it). */
      readonly speaker?: AgentSpeaker;
    }
  | {
      /**
       * No agent answers. `agent` still handles `/agent` and `/agents`; `notice`
       * is the kernel's reason, posted by the channel when there is no `agent`.
       */
      readonly kind: 'refused';
      readonly agent?: ChatAgent;
      readonly notice?: SystemNotice;
    }
  | {
      /** The resolver exists but failed. Nothing answers: there is no agent to fall back to. */
      readonly kind: 'unavailable';
    };

/** Who is asking and in which language the kernel writes its notices. */
export interface TelegramRouteContext {
  /** `turnPrincipal(...)`; absent when Telegram named no sender. */
  readonly principal?: string;
  /** `de` / `en` from the sender's Telegram `language_code`. */
  readonly locale: string;
}

/**
 * One routing lookup: the SDK's `resolveChannelRoute(ctx, type, key, context)`.
 * `undefined` means the host publishes no resolver (no multi-agent registry).
 */
export type ChannelRouteLookup = (
  channelType: string,
  channelKey: string,
  context: ChannelRouteContext,
) => ChannelResolveResult | undefined;

/** Kernel `match` of a result; not (yet) part of the SDK type, read structurally. */
function matchOf(result: ChannelResolveResult): string | undefined {
  const match = (result as { match?: unknown }).match;
  return typeof match === 'string' ? match : undefined;
}

/**
 * Per-turn resolution. `channelKeys` are probed narrowest first (chat id, then
 * the bot's `@username` and bare username), and the choice follows the S1 rule
 * that an agent selection hangs at the key the resolver was called with:
 *
 *  1. an `exclusive` result (the key IS an agent's own bot) wins over everything;
 *  2. otherwise the first `bound` result that something DECIDED for this key
 *     (a selection, a binding, an explicit address), narrowest key first;
 *  3. otherwise a `bound` result that is only the instance's default-agent
 *     table (`match: 'default'`, identical for every key, so it must not
 *     shadow a binding on a wider key);
 *  4. otherwise the first rejection: its agent still carries out `/agent` and
 *     stores the selection at the chat, its notice is posted.
 *
 * A result without `match` (older kernel) counts as decided, so the first
 * `bound` wins as before.
 *
 * There is NO fallback to the shared `chatAgent@1`: with a resolver it only
 * refuses. `defaultAgent` serves a host WITHOUT a resolver and nothing else; a
 * resolver that throws yields `unavailable`, never another agent.
 */
export function resolveAgentForTurn(
  lookup: ChannelRouteLookup | undefined,
  channelKeys: ReadonlyArray<string | undefined>,
  defaultAgent: ChatAgent,
  route: TelegramRouteContext,
  onError: (error: unknown) => void = () => undefined,
): AgentResolution {
  const context: ChannelRouteContext = {
    ...(route.principal ? { principal: route.principal } : {}),
    locale: route.locale,
  };
  const results: ChannelResolveResult[] = [];
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = lookup?.(CHANNEL_TYPE, key, context);
      if (result === undefined) return { kind: 'agent', agent: defaultAgent };
      results.push(result);
    }
  } catch (err) {
    onError(err);
    return { kind: 'unavailable' };
  }
  const exclusive = results.find((r) => r.exclusive === true);
  const decided = results.find((r) => r.decision === 'bound' && r.chatAgent && matchOf(r) !== 'default');
  const byDefault = results.find((r) => r.decision === 'bound' && r.chatAgent);
  const winner = exclusive ?? decided ?? byDefault;
  if (winner?.decision === 'bound' && winner.chatAgent) {
    return { kind: 'agent', agent: winner.chatAgent, ...(winner.speaker ? { speaker: winner.speaker } : {}) };
  }
  const rejected = exclusive ?? results[0];
  return rejected ? rejectionOf(rejected) : { kind: 'unavailable' };
}

function rejectionOf(result: ChannelResolveResult): Extract<AgentResolution, { kind: 'refused' }> {
  return {
    kind: 'refused',
    ...(result.chatAgent ? { agent: result.chatAgent } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
  };
}
