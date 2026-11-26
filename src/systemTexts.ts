/**
 * The bot's own system texts: the pairing welcome, the bare `/start`
 * greeting, the refusal for an unpaired DM and the group-activation notice.
 *
 * They name the system the operator configured in the `system_name` setup
 * field. Without one the system is called "omadia", so an installation never
 * shows another company's product name.
 */

export type SystemLocale = 'de' | 'en';

export const DEFAULT_SYSTEM_NAME = 'omadia';
/** Longer names are cut; a name is a label, not a sentence. */
const MAX_SYSTEM_NAME_LENGTH = 60;

/** The configured name, trimmed; the default when it is absent or blank. */
export function parseSystemName(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_SYSTEM_NAME;
  const name = raw.trim().slice(0, MAX_SYSTEM_NAME_LENGTH).trim();
  return name.length > 0 ? name : DEFAULT_SYSTEM_NAME;
}

/** The telegram user's language, as far as the bot's system texts go. */
export function systemLocaleOf(languageCode: string | undefined): SystemLocale {
  return /^en\b/i.test(languageCode ?? '') ? 'en' : 'de';
}

/**
 * The welcome after a pairing. The pairing allows this Telegram account to
 * chat with the bot; it does not link it to an omadia user (that needs the
 * kernel link of omadia ADR-0225, byte5ai/omadia#1995), so the text says
 * "allowed", never "connected as". The operator's label is named as the
 * pairing's label only.
 */
export function pairedWelcomeText(name: string, identityLabel: string, locale: SystemLocale): string {
  return locale === 'en'
    ? [
        `Welcome to the ${name} system!`,
        '',
        `Your Telegram account may now chat with me (pairing "${identityLabel}").`,
        '',
        'Just ask me a question, I answer directly.',
      ].join('\n')
    : [
        `Willkommen zum ${name} System!`,
        '',
        `Dein Telegram-Konto ist jetzt freigeschaltet (Pairing „${identityLabel}“).`,
        '',
        'Stell mir einfach eine Frage, ich antworte direkt.',
      ].join('\n');
}

export function greetingText(
  name: string,
  locale: SystemLocale,
  options: { readonly needsPairing?: boolean } = {},
): string {
  if (options.needsPairing) {
    return locale === 'en'
      ? `Welcome to the ${name} system! Before you can ask me anything, your account has to be paired: ask the operator for a pairing link and open it here.`
      : `Willkommen zum ${name} System! Bevor du mir Fragen stellen kannst, muss dein Konto gekoppelt werden: Bitte frag den Operator nach einem Pairing-Link und öffne ihn hier.`;
  }
  return locale === 'en'
    ? `Welcome to the ${name} system! You can ask me about your data.`
    : `Willkommen zum ${name} System! Du kannst mich Sachen über deine Daten fragen.`;
}

export function notPairedText(name: string, locale: SystemLocale): string {
  return locale === 'en'
    ? `You are not connected to the ${name} system yet. Please ask the operator for a pairing link.`
    : `Du bist noch nicht mit dem ${name} System verbunden. Bitte frag den Operator nach einem Pairing-Link.`;
}

export interface GroupActivationFacts {
  /** The bot's username, for the `@<bot>` and `/cmd@<bot>` forms. */
  readonly botUsername: string;
  /**
   * The bot receives every group message: BotFather privacy mode is off, or
   * it is an administrator of the group. Otherwise an @-mention never reaches
   * it (byte5ai/omadia#1997).
   */
  readonly readsAllMessages: boolean;
}

export function groupActivatedText(
  name: string,
  chatTitle: string,
  locale: SystemLocale,
  facts: GroupActivationFacts,
): string {
  const bot = `@${facts.botUsername}`;
  if (locale === 'en') {
    const head = `Group activated: the ${name} system is now enabled in the group "${chatTitle}".`;
    return facts.readsAllMessages
      ? `${head} Mention me there with ${bot}, reply to one of my messages, or use a command like /agent${bot}.`
      : [
          `${head} In the group, reply to one of my messages or use a command like /agent${bot}.`,
          '',
          `Privacy mode is on for this bot, so an @-mention (${bot}) does not reach me. To use @-mentions: in @BotFather send /setprivacy, choose this bot, select Disable, then remove the bot from the group and add it again. Making the bot an admin of the group works too.`,
        ].join('\n');
  }
  const head = `Gruppe aktiviert: Das ${name} System ist jetzt in der Gruppe „${chatTitle}“ freigeschaltet.`;
  return facts.readsAllMessages
    ? `${head} Erwähne mich dort mit ${bot}, antworte auf eine meiner Nachrichten oder nutze einen Befehl wie /agent${bot}.`
    : [
        `${head} Antworte dort auf eine meiner Nachrichten oder nutze einen Befehl wie /agent${bot}.`,
        '',
        `Für diesen Bot ist der Privacy-Mode aktiv, deshalb erreicht mich eine @-Erwähnung (${bot}) nicht. Für @-Erwähnungen: in @BotFather /setprivacy senden, den Bot wählen, Disable wählen, dann den Bot aus der Gruppe entfernen und neu hinzufügen. Alternativ den Bot zum Admin der Gruppe machen.`,
      ].join('\n');
}
