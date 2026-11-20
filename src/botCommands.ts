/**
 * The bot's native command menu (spec 2042 §5.3, issue #7).
 *
 * `/agent` is how a person chooses which agent answers in this conversation
 * (`/agent Mira`) or lists the agents available to them (`/agent`). The
 * parsing, the availability check and the stored selection belong to the
 * kernel's management layer; this channel only makes the command visible in
 * Telegram's "/" menu and passes the text on unchanged (`/agent@BotName Mira`
 * in groups included). The confirmation comes back as a `system` notice.
 */

import type { TelegramApiClient } from './telegramBot.js';

export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

/** Telegram limits: command 1-32 chars [a-z0-9_], description 3-256 chars. */
const COMMANDS_EN: readonly BotCommand[] = Object.freeze([
  { command: 'agent', description: 'Choose who you talk to: /agent Name, or /agent for the list' },
]);

const COMMANDS_DE: readonly BotCommand[] = Object.freeze([
  { command: 'agent', description: 'Gesprächspartner wählen: /agent Name, oder /agent für die Liste' },
]);

/** Menu entries per language; the first entry set is the default for every other language. */
export const BOT_COMMANDS: Readonly<Record<'default' | 'de', readonly BotCommand[]>> = Object.freeze({
  default: COMMANDS_EN,
  de: COMMANDS_DE,
});

/**
 * Register the menu. Best effort: a failure costs the menu, never the
 * channel, because `/agent` works as typed text either way.
 */
export async function registerBotCommands(
  api: Pick<TelegramApiClient, 'setMyCommands'>,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<void> {
  try {
    await api.setMyCommands({ commands: BOT_COMMANDS.default });
    await api.setMyCommands({ commands: BOT_COMMANDS.de, language_code: 'de' });
    log('info', 'telegram command menu registered (/agent)');
  } catch (err) {
    log(
      'warn',
      `setMyCommands failed: ${err instanceof Error ? err.message : String(err)} — /agent still works as typed text`,
    );
  }
}
