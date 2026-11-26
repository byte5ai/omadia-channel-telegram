/**
 * The keys this channel routes on, for the operator's `/operator/channels`
 * page (byte5ai/omadia#2001, SDK `ChannelKeyDirectory`, ADR-0135). Without a
 * directory the page listed no Telegram row, so an agent could not be bound
 * to a Telegram chat from the UI.
 *
 * The keys are exactly the ones `TelegramBot.routingKeys` resolves a turn on
 * (narrowest first): the chat id of an activated group or of a paired direct
 * chat (in Telegram a private chat's id is the person's user id), then the
 * installation bot's `@username`, which covers every chat of that bot. An
 * agent's own bot (`tg:<botId>`) is not listed: it IS its agent (spec 2042
 * §5.3) and needs no binding.
 */

import type { ChannelKeyDirectory, ChannelKeyEntry } from '@omadia/channel-sdk';

import type { PairingStore } from './pairingStore.js';

export interface TelegramChannelDirectoryDeps {
  /** The `channel_bindings.channel_type` turns are resolved under (`telegram`). */
  readonly channelType: string;
  readonly originPluginId: string;
  /** The installation bot's username, without `@`. */
  readonly botUsername: string;
  readonly pairingStore: Pick<PairingStore, 'listDmBindings' | 'listGroupActivations'>;
  readonly onError?: (what: string, err: unknown) => void;
}

export function createTelegramChannelDirectory(deps: TelegramChannelDirectoryDeps): ChannelKeyDirectory {
  return {
    channelType: deps.channelType,
    originPluginId: deps.originPluginId,
    async listKeys(): Promise<readonly ChannelKeyEntry[]> {
      const bot = `@${deps.botUsername}`;
      const [groups, dms] = await Promise.all([
        safely(() => deps.pairingStore.listGroupActivations(), 'group activations', deps.onError),
        safely(() => deps.pairingStore.listDmBindings(), 'dm bindings', deps.onError),
      ]);
      const groupRows: ChannelKeyEntry[] = groups.map((g) => ({
        key: String(g.chatId),
        label: `${g.chatTitle} · ${bot}`,
        hint: 'Telegram group',
      }));
      const dmRows: ChannelKeyEntry[] = dms.map((d) => ({
        key: String(d.telegramUserId),
        label: `${dmName(d)} · ${bot}`,
        hint: 'Telegram direct chat',
      }));
      return [{ key: bot, label: `${bot} (every chat of this bot)`, hint: 'Telegram bot' }, ...groupRows, ...dmRows];
    },
  };
}

function dmName(d: { telegramDisplayName?: string; telegramUsername?: string; telegramUserId: number }): string {
  const name = d.telegramDisplayName?.trim();
  if (name && d.telegramUsername) return `${name} (@${d.telegramUsername})`;
  if (name) return name;
  return d.telegramUsername ? `@${d.telegramUsername}` : `Telegram user ${String(d.telegramUserId)}`;
}

async function safely<T>(
  read: () => Promise<T[]>,
  what: string,
  onError: TelegramChannelDirectoryDeps['onError'],
): Promise<T[]> {
  try {
    return await read();
  } catch (err) {
    onError?.(what, err);
    return [];
  }
}
