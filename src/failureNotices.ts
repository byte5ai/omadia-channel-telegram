/**
 * What a person reads when a turn failed (byte5ai/omadia#2000). The notice
 * names the kind of failure in fixed words and never repeats the error
 * itself: provider and Bot API errors carry hosts, ids and internal wording
 * that belong in the log, not in the chat. The full error is logged by the
 * caller.
 */

import type { SystemLocale } from './systemTexts.js';

export type TurnFailureKind = 'provider_unreachable' | 'delivery_failed' | 'generic';

/**
 * Raised by the Bot API client for a refused call or a call that did not
 * reach Telegram (`errorCode` undefined), so a failed delivery is told apart
 * from a failed model call without reading the message.
 */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    description: string,
  ) {
    super(`Telegram API ${method} failed: ${description} (code=${String(errorCode)})`);
    this.name = 'TelegramApiError';
  }
}

/** Network and provider signals: the model could not be reached or refused for load. */
const PROVIDER_UNREACHABLE =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|timed? ?out|overloaded|rate.?limit|\b(429|502|503|504|529)\b|service unavailable/i;

export function classifyTurnFailure(err: unknown): TurnFailureKind {
  if (err instanceof TelegramApiError) return 'delivery_failed';
  const message = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && PROVIDER_UNREACHABLE.test(code)) return 'provider_unreachable';
  if (PROVIDER_UNREACHABLE.test(message)) return 'provider_unreachable';
  return 'generic';
}

const TEXTS: Readonly<Record<SystemLocale, Readonly<Record<TurnFailureKind, string>>>> = {
  de: {
    provider_unreachable:
      'Entschuldigung, das Sprachmodell ist gerade nicht erreichbar. Versuch es bitte in ein paar Minuten nochmal.',
    delivery_failed:
      'Entschuldigung, die Antwort konnte nicht zugestellt werden. Versuch es bitte nochmal oder stell die Frage anders.',
    generic:
      'Entschuldigung, beim Verarbeiten deiner Anfrage ist ein Fehler aufgetreten. Versuch es gleich nochmal oder stell die Frage anders.',
  },
  en: {
    provider_unreachable:
      'Sorry, the language model cannot be reached right now. Please try again in a few minutes.',
    delivery_failed:
      'Sorry, the answer could not be delivered. Please try again or rephrase your question.',
    generic:
      'Sorry, something went wrong while handling your request. Please try again or rephrase your question.',
  },
};

/** The fixed notice for a failed turn; never contains the error itself. */
export function failureNoticeText(kind: TurnFailureKind, locale: SystemLocale): string {
  return TEXTS[locale][kind];
}
