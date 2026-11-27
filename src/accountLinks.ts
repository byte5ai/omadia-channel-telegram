/**
 * Linking a Telegram account to an omadia account (byte5ai/omadia#1995,
 * ADR-0225 / ADR-0280).
 *
 * The kernel owns the link. This plugin never names the account a turn runs
 * as: the operator picks an account in the admin UI, the plugin asks the
 * kernel to OFFER a link (passing the operator's session cookie, from which
 * the kernel resolves the operator), and the bot REDEEMS the offer with the
 * sender of `/start <token>` — the Telegram account that proved it can open
 * the deep link.
 *
 * On a kernel without `CoreApi.channelIdentityLinks` the pairing stays a DM
 * allow-list, and every text says "allowed to chat", never "connected as".
 *
 * The capability is mirrored structurally (like `kernel-types.ts`) so this
 * package also builds against a channel-sdk that predates it.
 */

/** The channel type the kernel knows Telegram accounts under. */
export const TELEGRAM_LINK_CHANNEL_TYPE = 'telegram';

export type AccountLinkRefusal =
  | 'no_session'
  | 'unknown_user'
  | 'unsupported_channel'
  | 'unknown_offer'
  | 'not_linked'
  | 'unavailable';

type Outcome<T> = ({ readonly ok: true } & T) | { readonly ok: false; readonly reason: AccountLinkRefusal };

export interface LinkableAccountShim {
  readonly userId: string;
  readonly displayName: string;
  readonly email: string;
}

export interface AccountLinkShim {
  readonly userId: string;
  readonly displayName: string;
}

/** Mirror of channel-sdk `ChannelIdentityLinks` (0.3.19). */
export interface AccountLinks {
  listLinkableAccounts(cookieHeader: string | undefined): Promise<readonly LinkableAccountShim[] | null>;
  offerLink(
    cookieHeader: string | undefined,
    request: { readonly channelType: string; readonly userId: string; readonly ttlMs?: number },
  ): Promise<Outcome<{ readonly offerId: string; readonly account: AccountLinkShim; readonly expiresAt: string }>>;
  redeemLink(request: {
    readonly channelType: string;
    readonly channelUserId: string;
    readonly offerId: string;
    readonly displayName?: string;
  }): Promise<Outcome<{ readonly link: AccountLinkShim }>>;
  unlink(
    cookieHeader: string | undefined,
    request: { readonly channelType: string; readonly channelUserId: string },
  ): Promise<Outcome<Record<never, never>>>;
}

/** The kernel's link capability, when this kernel ships it. */
export function accountLinksOf(core: object): AccountLinks | undefined {
  const links = (core as { channelIdentityLinks?: unknown }).channelIdentityLinks;
  if (!links || typeof links !== 'object') return undefined;
  const candidate = links as Partial<AccountLinks>;
  return typeof candidate.offerLink === 'function' &&
    typeof candidate.redeemLink === 'function' &&
    typeof candidate.unlink === 'function' &&
    typeof candidate.listLinkableAccounts === 'function'
    ? (links as AccountLinks)
    : undefined;
}

/**
 * The id a Telegram sender's turns carry as `ChatTurnInput.userId`. The
 * kernel keys the sender's identity on exactly this string, so a link must
 * name it the same way.
 */
export function telegramTurnUserId(telegramUserId: number): string {
  return `telegram:${String(telegramUserId)}`;
}

/**
 * HTTP status for a refusal the admin API passes on. A missing operator
 * session is 403, not 401: the admin UI reads 401 as "bearer token invalid"
 * and signs the operator out.
 */
export function refusalStatus(reason: AccountLinkRefusal): number {
  switch (reason) {
    case 'no_session':
      return 403;
    case 'unknown_user':
    case 'unknown_offer':
      return 400;
    case 'not_linked':
      return 404;
    case 'unsupported_channel':
      return 409;
    case 'unavailable':
      return 503;
  }
}
