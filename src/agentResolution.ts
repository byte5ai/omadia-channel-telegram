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
  ChannelBindingResolver,
  ChannelResolveResult,
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
    };

/** Who is asking and in which language the kernel writes its notices. */
export interface TelegramRouteContext {
  /** `turnPrincipal(...)`; absent when Telegram named no sender. */
  readonly principal?: string;
  readonly locale: string;
}

/** The resolver as the bot consumes it: looked up per turn, absent without a registry. */
export type ChannelResolverLookup = () => Pick<ChannelBindingResolver, 'resolve'> | undefined;

/**
 * Per-turn resolution. `channelKeys` are tried most specific first (chat id,
 * then the bot's `@username`); a `bound` decision wins immediately, otherwise
 * the first rejection stands.
 *
 * `defaultAgent` serves only a host WITHOUT the resolver (single-agent or
 * Postgres-less deployment) and a resolver that throws, so a hiccup never
 * drops a turn. A throwing resolver is not a rejection.
 */
export function resolveAgentForTurn(
  lookup: ChannelResolverLookup | undefined,
  channelKeys: ReadonlyArray<string | undefined>,
  defaultAgent: ChatAgent,
  route: TelegramRouteContext,
  onError: (error: unknown) => void = () => undefined,
): AgentResolution {
  const resolver = lookup?.();
  if (!resolver) return { kind: 'agent', agent: defaultAgent };
  let rejection: Extract<AgentResolution, { kind: 'refused' }> | undefined;
  try {
    for (const key of channelKeys) {
      if (!key) continue;
      const result = resolver.resolve(CHANNEL_TYPE, key, {
        ...(route.principal ? { principal: route.principal } : {}),
        locale: route.locale,
      });
      if (result.decision === 'bound' && result.chatAgent) {
        return { kind: 'agent', agent: result.chatAgent, ...(result.speaker ? { speaker: result.speaker } : {}) };
      }
      rejection ??= rejectionOf(result);
    }
  } catch (err) {
    onError(err);
    return { kind: 'agent', agent: defaultAgent };
  }
  return rejection ?? { kind: 'agent', agent: defaultAgent };
}

function rejectionOf(result: ChannelResolveResult): Extract<AgentResolution, { kind: 'refused' }> {
  return {
    kind: 'refused',
    ...(result.chatAgent ? { agent: result.chatAgent } : {}),
    ...(result.notice ? { notice: result.notice } : {}),
  };
}
