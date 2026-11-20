/**
 * The bot's native command menu (spec 2042 §5.3, issue #7).
 *
 * `/agent Mira` chooses which agent answers in this conversation, `/agent`
 * without a name clears that choice again, `/agents` lists the agents available
 * to the person. None of it is handled here: the channel only makes the
 * commands visible in Telegram's "/" menu and passes the text on unchanged
 * (`/agent@BotName Mira` in groups included) to the agent behind the kernel's
 * channel resolver, which carries them out and confirms as a `system` notice.
 */

import type { TelegramApiClient } from './telegramBot.js';

export interface BotCommand {
  readonly command: string;
  readonly description: string;
}

/** Telegram limits: command 1-32 chars [a-z0-9_], description 3-256 chars. */
const COMMANDS_EN: readonly BotCommand[] = Object.freeze([
  { command: 'agent', description: 'Choose who you talk to: /agent Name. Without a name the choice is cleared' },
  { command: 'agents', description: 'List the agents available to you here' },
]);

const COMMANDS_DE: readonly BotCommand[] = Object.freeze([
  { command: 'agent', description: 'Gesprächspartner wählen: /agent Name. Ohne Name wird die Auswahl gelöscht' },
  { command: 'agents', description: 'Zeigt die Agenten, die du hier nutzen kannst' },
]);

/** Menu entries per language; the first entry set is the default for every other language. */
export const BOT_COMMANDS: Readonly<Record<'default' | 'de', readonly BotCommand[]>> = Object.freeze({
  default: COMMANDS_EN,
  de: COMMANDS_DE,
});

/**
 * Register the menu. Best effort: a failure costs the menu, never the
 * channel, because the commands work as typed text either way.
 */
export async function registerBotCommands(
  api: Pick<TelegramApiClient, 'setMyCommands'>,
  log: (level: 'info' | 'warn', message: string) => void,
): Promise<void> {
  try {
    await api.setMyCommands({ commands: BOT_COMMANDS.default });
    await api.setMyCommands({ commands: BOT_COMMANDS.de, language_code: 'de' });
    log('info', 'telegram command menu registered (/agent, /agents)');
  } catch (err) {
    log(
      'warn',
      `setMyCommands failed: ${err instanceof Error ? err.message : String(err)} — /agent and /agents still work as typed text`,
    );
  }
}
