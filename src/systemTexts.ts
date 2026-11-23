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

export function pairedWelcomeText(name: string, identityLabel: string, locale: SystemLocale): string {
  return locale === 'en'
    ? [
        `Welcome to the ${name} system!`,
        '',
        `You are connected as ${identityLabel}.`,
        '',
        'Just ask me a question, I answer directly.',
      ].join('\n')
    : [
        `Willkommen zum ${name} System!`,
        '',
        `Du bist verbunden als ${identityLabel}.`,
        '',
        'Stell mir einfach eine Frage, ich antworte direkt.',
      ].join('\n');
}

export function greetingText(name: string, locale: SystemLocale): string {
  return locale === 'en'
    ? `Welcome to the ${name} system! You can ask me about your data.`
    : `Willkommen zum ${name} System! Du kannst mich Sachen über deine Daten fragen.`;
}

export function notPairedText(name: string, locale: SystemLocale): string {
  return locale === 'en'
    ? `You are not connected to the ${name} system yet. Please ask the operator for a pairing link.`
    : `Du bist noch nicht mit dem ${name} System verbunden. Bitte frag den Operator nach einem Pairing-Link.`;
}

export function groupActivatedText(name: string, chatTitle: string, locale: SystemLocale): string {
  return locale === 'en'
    ? `Group activated: the ${name} system is now enabled in the group "${chatTitle}". Write to me there (with an @-mention while privacy mode is on).`
    : `Gruppe aktiviert: Das ${name} System ist jetzt in der Gruppe „${chatTitle}“ freigeschaltet. Schreib mich dort einfach an (mit @-Mention, solange der Privacy-Mode aktiv ist).`;
}
