/**
 * Telegram channel adapter. Speaks the Bot API directly via fetch — no
 * third-party SDK. Handles the inbound Update envelope (message +
 * callback_query) and drives the orchestrator; outgoing wire-format
 * rendering (MarkdownV2, inline keyboards, callback_data tokenisation)
 * lives in telegramRenderer.ts.
 *
 * Scope (v1):
 * - Text messages → ChatAgent.chat → renderer.renderAnswer(...)
 * - Inline-keyboard interactives via renderer
 * - Group rosters via getChatAdministrators (best-effort; non-admin members
 *   stay invisible — Bot API gives no public membership listing)
 * - Pending-callback resolution: renderer.takePendingCallback resolves the
 *   token into the stashed echo string, which is fed back as the next user
 *   message
 *
 * Out of scope (deferred):
 * - SSO / OBO (no Telegram equivalent of Bot-Framework userTokenClient)
 * - Topic-detector dance (history passes through unchanged)
 * - File attachments inbound (only photo + document echo for now)
 * - Trace panel rendering (skip the runTrace summary)
 */

import { isNoReply, logNoReplyDrop } from '@omadia/channel-sdk';
import { evaluateDmPolicy, type DmPolicy } from './dmPolicyGuard.js';
import type {
  ChatAgent,
  ChatParticipantsProvider,
  ConversationHistoryStore,
  TurnContextModule,
} from './kernel-types.js';
import type { PairingStore } from './pairingStore.js';
import type { PairingTokenRegistry } from './pairingTokens.js';
import { escapeHtml } from './markdownToHtml.js';
import {
  TelegramRenderer,
  type InlineKeyboardMarkup,
} from './telegramRenderer.js';

// ---------------------------------------------------------------------------
// Bot API envelope — narrow shapes for the fields we read
// ---------------------------------------------------------------------------

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  /** S+7.6 — bot's own chat-member status changed (added, removed, promoted, …) */
  my_chat_member?: ChatMemberUpdated;
}

/**
 * Subset of Bot-API ChatMemberUpdated. We only read the bot's own status
 * transitions to decide group-activation; the full payload has more fields
 * (notably `invite_link` for via-link adds) which we don't need yet.
 */
export interface ChatMemberUpdated {
  chat: TelegramChat;
  /** The user who triggered the membership change (may be the bot itself for self-leave). */
  from: TelegramUser;
  /** Unix epoch (seconds). */
  date: number;
  old_chat_member: ChatMember;
  new_chat_member: ChatMember;
}

export interface ChatMember {
  user: TelegramUser;
  status:
    | 'creator'
    | 'administrator'
    | 'member'
    | 'restricted'
    | 'left'
    | 'kicked';
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  thumb?: TelegramPhotoSize;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  /** Caption attached to a photo/document (often replaces text for media). */
  caption?: string;
  /** Photo variants — array sorted by size; use the LAST entry for max-res. */
  photo?: TelegramPhotoSize[];
  /** Document attachment (any file). Image-MIME documents handled like photos. */
  document?: TelegramDocument;
  /** Entities (mentions, urls, …) attached to a CAPTION (vs `entities` on text). */
  caption_entities?: TelegramMessageEntity[];
  /**
   * Telegram-detected entities (mentions, hashtags, urls, …). For our
   * mention-filter only the `mention` and `text_mention` types matter:
   *   - `mention`: classic `@username` style — `text.slice(offset, offset+length)` = "@botname"
   *   - `text_mention`: rare, references a user by id directly (no @)
   */
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramMessageEntity {
  type:
    | 'mention'
    | 'text_mention'
    | 'hashtag'
    | 'cashtag'
    | 'bot_command'
    | 'url'
    | 'email'
    | 'phone_number'
    | 'bold'
    | 'italic'
    | 'underline'
    | 'strikethrough'
    | 'spoiler'
    | 'code'
    | 'pre'
    | 'text_link'
    | 'custom_emoji'
    | string;
  offset: number;
  length: number;
  /** Present iff type === 'text_mention'. */
  user?: TelegramUser;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

// ---------------------------------------------------------------------------
// Bot API client (thin)
// ---------------------------------------------------------------------------

export class TelegramApiClient {
  private readonly base: string;

  constructor(private readonly botToken: string) {
    this.base = `https://api.telegram.org/bot${botToken}`;
  }

  async sendMessage(params: {
    chat_id: number;
    text: string;
    parse_mode?: 'MarkdownV2' | 'HTML';
    reply_markup?: InlineKeyboardMarkup;
    disable_web_page_preview?: boolean;
  }): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>('sendMessage', params);
  }

  async sendPhoto(params: {
    chat_id: number;
    photo: string;
    caption?: string;
    parse_mode?: 'MarkdownV2' | 'HTML';
  }): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>('sendPhoto', params);
  }

  async sendDocument(params: {
    chat_id: number;
    document: string;
    caption?: string;
    parse_mode?: 'MarkdownV2' | 'HTML';
  }): Promise<TelegramMessage> {
    return await this.call<TelegramMessage>('sendDocument', params);
  }

  async sendChatAction(params: {
    chat_id: number;
    action: 'typing' | 'upload_photo' | 'upload_document';
  }): Promise<true> {
    return await this.call<true>('sendChatAction', params);
  }

  async answerCallbackQuery(params: {
    callback_query_id: string;
    text?: string;
    show_alert?: boolean;
  }): Promise<true> {
    return await this.call<true>('answerCallbackQuery', params);
  }

  async setWebhook(params: {
    url: string;
    secret_token?: string;
    allowed_updates?: Array<'message' | 'callback_query' | 'my_chat_member'>;
    drop_pending_updates?: boolean;
  }): Promise<true> {
    return await this.call<true>('setWebhook', params);
  }

  async deleteWebhook(params?: {
    drop_pending_updates?: boolean;
  }): Promise<true> {
    return await this.call<true>('deleteWebhook', params ?? {});
  }

  async getWebhookInfo(): Promise<{
    url: string;
    has_custom_certificate: boolean;
    pending_update_count: number;
    last_error_date?: number;
    last_error_message?: string;
  }> {
    return await this.call('getWebhookInfo', {});
  }

  async getMe(): Promise<TelegramUser> {
    return await this.call<TelegramUser>('getMe', {});
  }

  async getChatAdministrators(params: {
    chat_id: number;
  }): Promise<Array<{ user: TelegramUser; status: string }>> {
    return await this.call('getChatAdministrators', params);
  }

  async getUpdates(params: {
    offset?: number;
    timeout?: number;
    allowed_updates?: Array<'message' | 'callback_query' | 'my_chat_member'>;
  }): Promise<TelegramUpdate[]> {
    return await this.call('getUpdates', params);
  }

  /**
   * Resolve a file_id to a downloadable file_path (S+7.7+ — image upload
   * support). The file_path is the relative path on Telegram's file CDN;
   * combine with `https://api.telegram.org/file/bot<TOKEN>/<file_path>`
   * to fetch the actual bytes. URL is valid for ~1h. NEVER log or echo
   * the assembled URL — it contains the bot token in path-form which
   * grants direct file access.
   */
  async getFile(params: {
    file_id: string;
  }): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
    return await this.call('getFile', params);
  }

  /** Convenience: getFile + GET to the file CDN, returns bytes. */
  async downloadFile(file_id: string): Promise<{ bytes: Buffer; sizeBytes: number; mediaType: string | undefined }> {
    const meta = await this.getFile({ file_id });
    if (!meta.file_path) throw new Error(`Telegram getFile: no file_path for file_id=${file_id}`);
    const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${meta.file_path}`;
    const res = await fetch(fileUrl);
    if (!res.ok) {
      throw new Error(`Telegram file CDN ${String(res.status)} for file_id=${file_id}`);
    }
    const arr = new Uint8Array(await res.arrayBuffer());
    const mediaType = res.headers.get('content-type') ?? undefined;
    return {
      bytes: Buffer.from(arr),
      sizeBytes: arr.byteLength,
      mediaType,
    };
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = (await res.json()) as {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
    };
    if (!json.ok || json.result === undefined) {
      throw new Error(
        `Telegram API ${method} failed: ${json.description ?? 'unknown'} (code=${String(json.error_code)})`,
      );
    }
    return json.result;
  }
}

// ---------------------------------------------------------------------------
// Bot orchestration
// ---------------------------------------------------------------------------

export interface TelegramBotOptions {
  api: TelegramApiClient;
  chatAgent: ChatAgent;
  history: ConversationHistoryStore;
  turnContext: TurnContextModule;
  /** Optional roster lookup; only invoked for group/supergroup chats. */
  rosterProvider?: (chatId: number) => ChatParticipantsProvider;
  /** Per-chat lock to serialise concurrent callback_query + message turns. */
  pendingCallbackTtlMs?: number;
  /** Pairing infrastructure (S+7.6). Both required for /start <token> to work. */
  pairingStore: PairingStore;
  pairingTokens: PairingTokenRegistry;
  /** DM auth policy (S+7.6). Defaults to 'pairing' if not specified by caller. */
  dmPolicy?: DmPolicy;
  /**
   * Bot identity (S+7.7+). Used to filter group messages so the bot only
   * answers when explicitly addressed (mention or reply) — necessary when
   * BotFather privacy-mode is OFF (otherwise the bot would echo into every
   * group message). Always recommended even when privacy-on, as a defense
   * against legacy-group filtering quirks.
   */
  botIdentity: { id: number; username: string };
}

const DEFAULT_CALLBACK_TTL_MS = 10 * 60 * 1000; // 10 min

export class TelegramBot {
  private readonly api: TelegramApiClient;
  private readonly chatAgent: ChatAgent;
  private readonly history: ConversationHistoryStore;
  private readonly turnContext: TurnContextModule;
  private readonly rosterProviderFactory:
    | ((chatId: number) => ChatParticipantsProvider)
    | undefined;
  private readonly renderer: TelegramRenderer;
  private readonly pairingStore: PairingStore;
  private readonly pairingTokens: PairingTokenRegistry;
  private readonly dmPolicy: DmPolicy;
  private readonly botIdentity: { id: number; username: string };

  constructor(opts: TelegramBotOptions) {
    this.api = opts.api;
    this.chatAgent = opts.chatAgent;
    this.history = opts.history;
    this.turnContext = opts.turnContext;
    this.rosterProviderFactory = opts.rosterProvider;
    this.renderer = new TelegramRenderer(
      this.api,
      opts.pendingCallbackTtlMs ?? DEFAULT_CALLBACK_TTL_MS,
    );
    this.pairingStore = opts.pairingStore;
    this.pairingTokens = opts.pairingTokens;
    this.dmPolicy = opts.dmPolicy ?? 'pairing';
    this.botIdentity = opts.botIdentity;
  }

  /** Single entry-point — dispatches on update.message / callback_query / my_chat_member. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }
    if (update.message) {
      await this.handleMessage(update.message);
      return;
    }
    if (update.my_chat_member) {
      await this.handleChatMemberUpdate(update.my_chat_member);
      return;
    }
    // Other update kinds (edited_message, channel_post, …) are silently
    // ignored — out of scope for v1.
  }

  /**
   * Handle bot's own membership change. Used for group auto-allowlisting
   * (S+7.6 Sub-Commit 5): when a paired DM operator adds the bot to a
   * group, we persist a GroupActivation so subsequent group messages
   * pass the group-state check in runTurn(). Other transitions
   * (promote-to-admin, kick, leave) are logged but not acted on.
   *
   * Bot-API guarantees `from` is the user who triggered the change;
   * for adds we cross-check that user against the DM pairing store.
   * Non-paired adders get a silent no-op — bot stays invisible in the
   * unknown group (Marcel-decision: spammers shouldn't see "this group
   * is not activated" replies).
   */
  private async handleChatMemberUpdate(
    upd: ChatMemberUpdated,
  ): Promise<void> {
    const isGroup =
      upd.chat.type === 'group' || upd.chat.type === 'supergroup';
    if (!isGroup) return; // Private/channel transitions don't matter

    const wasAbsent =
      upd.old_chat_member.status === 'left' ||
      upd.old_chat_member.status === 'kicked';
    const nowPresent =
      upd.new_chat_member.status === 'member' ||
      upd.new_chat_member.status === 'administrator' ||
      upd.new_chat_member.status === 'restricted';

    if (!(wasAbsent && nowPresent)) {
      // Other transitions: log + bail. Future hooks can branch here on
      // promote/demote/kick if we want richer auditing.
      console.log(
        `[telegram] chat-member transition (no-op): chat=${String(upd.chat.id)} status=${upd.old_chat_member.status}→${upd.new_chat_member.status}`,
      );
      return;
    }

    // Bot was just added. Cross-check the inviter against the DM
    // pairing store.
    const adderBinding = await this.pairingStore.getDmBinding(upd.from.id);
    if (!adderBinding) {
      console.log(
        `[telegram] bot added to chat=${String(upd.chat.id)} (${upd.chat.title ?? 'no-title'}) by NON-PAIRED user telegram:${String(upd.from.id)} (@${upd.from.username ?? 'no-username'}) — NOT activating, bot stays silent`,
      );
      return;
    }

    // Idempotent: if already activated, just refresh metadata.
    const activation = {
      chatId: upd.chat.id,
      chatTitle: upd.chat.title ?? `chat:${String(upd.chat.id)}`,
      chatType: upd.chat.type as 'group' | 'supergroup',
      activatedBy: adderBinding.harnessIdentityId,
      activatedVia: 'auto' as const,
      activatedAt: new Date().toISOString(),
    };
    await this.pairingStore.putGroupActivation(activation);
    console.log(
      `[telegram] group activated chat=${String(upd.chat.id)} (${activation.chatTitle}) by harness=${adderBinding.harnessIdentityId} (${adderBinding.harnessIdentityLabel}) via my_chat_member auto-allowlist`,
    );

    // DM-Confirm to the operator. Best-effort — if the operator has
    // blocked the bot's DMs, the send fails silently and only the log
    // captures the activation. Telegram delivers DMs to user IDs even
    // without a prior /start, since the user has chatted with the bot
    // before (via the pairing flow).
    try {
      await this.api.sendMessage({
        chat_id: upd.from.id,
        text: [
          '<b>Gruppe aktiviert</b>',
          '',
          `Der byte5 Harness Bot ist jetzt freigeschaltet in der Gruppe „${escapeHtml(activation.chatTitle)}“. Schreib mich dort einfach an (mit @-Mention wenn der Privacy-Mode aktiv ist).`,
        ].join('\n'),
        parse_mode: 'HTML',
      });
    } catch (err) {
      console.warn(
        `[telegram] DM-confirm to harness=${adderBinding.harnessIdentityId} failed: ${err instanceof Error ? err.message : String(err)} (group still activated)`,
      );
    }
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    // S+7.7+ — image-message support. Photos and image-MIME documents
    // become inbound attachments + an implicit caption-or-default text.
    // Pure-text messages still take the original text path.
    const inboundImages = await this.collectInboundImages(message);

    const rawText = message.text?.trim() ?? message.caption?.trim() ?? '';
    if (!rawText && inboundImages.length === 0) {
      // Truly empty: stickers, voice, video without caption — out of scope.
      await this.api.sendMessage({
        chat_id: message.chat.id,
        text: 'Ich kann derzeit nur Text-Nachrichten und Bilder verarbeiten.',
      });
      return;
    }
    // For images without caption, give the orchestrator a generic
    // "describe this" prompt so vision-flow doesnt choke on empty text.
    const text = rawText.length > 0
      ? rawText
      : 'Was siehst du auf diesem Bild?';

    // /start <token> → pairing branch (S+7.6). Telegram clients send this
    // exact prefix when the user clicks a `https://t.me/<bot>?start=<token>`
    // deep-link and confirms with the Start button. Group /start@bot calls
    // are scoped to private chats here: pairing only binds 1:1 user → harness
    // identity, never group → identity (groups have their own activation
    // flow via Sub-Commit 5).
    //
    // The pairing branch runs BEFORE the dmPolicy guard so pairing remains
    // self-bootstrapping (otherwise the first DM from a fresh user would
    // be refused before they could even bind).
    if (text.startsWith('/start ') && message.chat.type === 'private') {
      await this.handleStartWithToken({
        chat: message.chat,
        from: message.from,
        token: text.slice('/start '.length).trim(),
      });
      return;
    }

    // dmPolicy guard (S+7.6): only applies to private chats. Groups use
    // their own activation flow (Sub-Commit 5, my_chat_member event).
    if (message.chat.type === 'private' && message.from) {
      const decision = await evaluateDmPolicy({
        policy: this.dmPolicy,
        telegramUserId: message.from.id,
        store: this.pairingStore,
      });
      if (!decision.allow) {
        if (decision.refusal) {
          await this.api.sendMessage({
            chat_id: message.chat.id,
            text: decision.refusal,
            parse_mode: 'HTML',
          });
        }
        // disabled-mode: silent — log a marker so operators can audit
        console.log(
          `[telegram] dm refused chat=${String(message.chat.id)} user=telegram:${String(message.from.id)} policy=${this.dmPolicy}`,
        );
        return;
      }
    }

    // Group/supergroup gate (S+7.6): silent ignore for not-yet-activated
    // groups. Bot stays invisible until a paired DM operator adds it
    // (handled in handleChatMemberUpdate). Marcel-decision: spammers
    // shouldn't see "this group is not activated" replies; silent =
    // no probe-leak.
    let userMessage = text;
    if (
      message.chat.type === 'group' ||
      message.chat.type === 'supergroup'
    ) {
      const activation = await this.pairingStore.getGroupActivation(
        message.chat.id,
      );
      if (!activation) {
        console.log(
          `[telegram] group message ignored chat=${String(message.chat.id)} (${message.chat.title ?? 'no-title'}) — no activation, silent`,
        );
        return;
      }
      // Mention filter (S+7.7+): in groups, only respond when explicitly
      // addressed. Required when BotFather privacy-mode is OFF (otherwise
      // every group message reaches the bot and would echo back). Even
      // with privacy-on this filter is a safe defense against legacy-
      // group server-side delivery quirks.
      if (!this.isBotAddressedInGroup(message)) {
        console.log(
          `[telegram] group message ignored chat=${String(message.chat.id)} — not addressed (no @-mention, no reply, no /cmd@bot)`,
        );
        return;
      }
      // Strip the leading bot mention from userMessage so the orchestrator
      // sees a clean prompt (e.g. "@telebitch_bot was geht" → "was geht").
      // Use caption_entities when the source text was the caption
      // (image-with-caption messages keep entities under caption_entities).
      const stripEntities =
        message.text != null
          ? message.entities
          : message.caption_entities;
      userMessage = this.stripBotMention(text, stripEntities);
    }

    await this.runTurn({
      chat: message.chat,
      from: message.from,
      userMessage,
      attachments: inboundImages,
    });
  }

  /**
   * Detect photo[] or image-MIME document on the message, getFile + CDN-
   * download bytes, base64-encode, return an attachment list ready to
   * hand to the orchestrator.
   *
   * Telegram limits:
   * - photos: max 10MB per variant, server gives multiple sizes — we
   *   pick the LAST entry (highest resolution).
   * - documents: max 20MB. We accept only image/* MIME and clamp at 5MB
   *   to stay under Anthropic's per-image cap (5MB base64-decoded).
   *
   * Failures are logged + dropped (the turn proceeds with the remaining
   * inputs); we never crash a turn on a download error.
   */
  private async collectInboundImages(
    message: TelegramMessage,
  ): Promise<
    Array<{
      kind: 'image';
      url: string;
      mediaType: string;
      name?: string;
      sizeBytes: number;
      bytesBase64: string;
    }>
  > {
    const out: Array<{
      kind: 'image';
      url: string;
      mediaType: string;
      name?: string;
      sizeBytes: number;
      bytesBase64: string;
    }> = [];

    // Photo: try variants from largest to smallest, take FIRST one that
    // fits the 5MB Anthropic cap. Telegram photo[] is sorted ascending
    // by resolution; iterate descending. Telegram-side `photo` entries
    // are always re-encoded to JPEG by Telegram itself, regardless of
    // the original upload format — so the CDN content-type can be
    // trusted to be image/jpeg, but we still normalise via
    // normaliseAnthropicMediaType to be defensive.
    if (message.photo && message.photo.length > 0) {
      console.log(
        `[telegram] inbound photo detected chat=${String(message.chat.id)} variants=${String(message.photo.length)}`,
      );
      for (let i = message.photo.length - 1; i >= 0; i--) {
        const variant = message.photo[i];
        if (!variant) continue;
        const dl = await this.tryDownloadImage(variant.file_id);
        if (!dl) continue;
        if (dl.sizeBytes > 5 * 1024 * 1024) {
          console.warn(
            `[telegram] photo variant idx=${String(i)} too large (${String(dl.sizeBytes)} bytes > 5MB) — trying smaller`,
          );
          continue;
        }
        const mediaType = normaliseAnthropicMediaType(dl.mediaType, 'image/jpeg');
        out.push({
          kind: 'image',
          url: `tg://file/${variant.file_id}`,
          mediaType,
          sizeBytes: dl.sizeBytes,
          bytesBase64: dl.bytes.toString('base64'),
        });
        console.log(
          `[telegram] inbound photo variant idx=${String(i)} accepted (${String(dl.sizeBytes)} bytes, ${mediaType})`,
        );
        break;
      }
    }
    // Document with image MIME — single candidate, take or reject. Unlike
    // photo[], document mime can be any of HEIC / TIFF / BMP / SVG /
    // image/anything — Anthropic only takes 4 (jpeg, png, gif, webp), so
    // filter strictly here. HEIC + others are dropped with a clear log.
    if (
      message.document &&
      message.document.mime_type &&
      message.document.mime_type.startsWith('image/')
    ) {
      console.log(
        `[telegram] inbound image-document detected chat=${String(message.chat.id)} mime=${message.document.mime_type}`,
      );
      const declaredMime = message.document.mime_type;
      const acceptableMime = normaliseAnthropicMediaType(declaredMime, undefined);
      if (!acceptableMime) {
        console.warn(
          `[telegram] image-document mime ${declaredMime} not accepted by Anthropic (only jpeg/png/gif/webp) — skipping. Resend the image as Telegram-photo instead of file/document.`,
        );
      } else {
        const dl = await this.tryDownloadImage(message.document.file_id);
        if (dl) {
          if (dl.sizeBytes > 5 * 1024 * 1024) {
            console.warn(
              `[telegram] image-document too large (${String(dl.sizeBytes)} bytes > 5MB) — skipping`,
            );
          } else {
            out.push({
              kind: 'image',
              url: `tg://file/${message.document.file_id}`,
              mediaType: acceptableMime,
              ...(message.document.file_name
                ? { name: message.document.file_name }
                : {}),
              sizeBytes: dl.sizeBytes,
              bytesBase64: dl.bytes.toString('base64'),
            });
          }
        }
      }
    }
    return out;
  }

  /** Wrapped downloadFile that returns undefined on error (warn-logged). */
  private async tryDownloadImage(
    file_id: string,
  ): Promise<{ bytes: Buffer; sizeBytes: number; mediaType: string | undefined } | undefined> {
    try {
      return await this.api.downloadFile(file_id);
    } catch (err) {
      console.warn(
        `[telegram] image download failed (file_id=${file_id}): ${err instanceof Error ? err.message : String(err)} — dropping`,
      );
      return undefined;
    }
  }

  /**
   * Returns true iff the message in a group/supergroup explicitly addresses
   * this bot. Rules (any one matches):
   *   - `mention` entity whose text is `@<bot_username>` (case-insensitive)
   *   - `text_mention` entity with user.id === botIdentity.id (rare;
   *     happens when someone mentions a bot via @-completion in a chat
   *     that has the bot as a member)
   *   - `bot_command` entity whose text contains `@<bot_username>` (e.g.
   *     `/help@bot`) — slash-commands without `@bot` suffix are NOT
   *     addressed unless they're a /-prefix in a private chat
   *   - `reply_to_message.from.id === botIdentity.id` — replies to bot
   *     messages count as addressed regardless of @-mention
   */
  private isBotAddressedInGroup(message: TelegramMessage): boolean {
    const expected = `@${this.botIdentity.username.toLowerCase()}`;
    if (
      message.reply_to_message?.from?.id === this.botIdentity.id
    ) {
      return true;
    }
    // Check both `text` + `entities` (regular message) AND `caption` +
    // `caption_entities` (photo / document with caption). The fix for
    // S+7.7+ image-with-caption use case: an @-mention inside an image
    // caption lives in caption_entities, NOT entities — without this
    // check the bot would silently ignore the message.
    const sources: Array<{ text: string; entities?: TelegramMessageEntity[] }> = [
      { text: message.text ?? '', ...(message.entities ? { entities: message.entities } : {}) },
      {
        text: message.caption ?? '',
        ...(message.caption_entities ? { entities: message.caption_entities } : {}),
      },
    ];
    for (const src of sources) {
      for (const entity of src.entities ?? []) {
        if (entity.type === 'mention') {
          const mentionText = src.text
            .slice(entity.offset, entity.offset + entity.length)
            .toLowerCase();
          if (mentionText === expected) return true;
        } else if (
          entity.type === 'text_mention' &&
          entity.user?.id === this.botIdentity.id
        ) {
          return true;
        } else if (entity.type === 'bot_command') {
          const cmd = src.text.slice(
            entity.offset,
            entity.offset + entity.length,
          );
          if (cmd.toLowerCase().endsWith(expected)) return true;
        }
      }
    }
    return false;
  }

  /**
   * Remove the bot's @-mention from the start of the text — only used in
   * group/supergroup chats after isBotAddressedInGroup returned true. The
   * orchestrator should see a clean prompt without "@telebitch_bot " noise.
   * Conservative: only strips if the mention is the FIRST token.
   */
  private stripBotMention(
    text: string,
    entities: TelegramMessageEntity[] | undefined,
  ): string {
    if (!entities) return text;
    const expected = `@${this.botIdentity.username.toLowerCase()}`;
    for (const entity of entities) {
      if (entity.type !== 'mention') continue;
      if (entity.offset !== 0) continue; // only strip when at start
      const mention = text
        .slice(entity.offset, entity.offset + entity.length)
        .toLowerCase();
      if (mention !== expected) continue;
      return text.slice(entity.offset + entity.length).trimStart();
    }
    return text;
  }

  /**
   * Pairing-flow consume step. Validates the start-deeplink token, persists
   * the telegram_user_id → harness_identity binding, and confirms in the
   * chat. Idempotent on the same token (consumed exactly once); a second
   * click on a stale link returns the polite-expired reply, NOT an error.
   *
   * If the same telegram_user_id is already bound to a DIFFERENT harness
   * identity, we OVERWRITE — the operator just issued a new pairing for
   * this user, intentional rebinding. Logged for audit.
   */
  private async handleStartWithToken(input: {
    chat: TelegramChat;
    from?: TelegramUser;
    token: string;
  }): Promise<void> {
    if (!input.from) {
      // Telegram always populates `from` for private-chat messages; if it
      // doesn't, the update is malformed. Refuse silently with a generic
      // hint so we don't leak the pairing mechanism.
      await this.api.sendMessage({
        chat_id: input.chat.id,
        text: 'Ich konnte deinen Telegram-Account nicht erkennen.',
      });
      return;
    }
    if (input.token.length === 0) {
      // Bare /start with no token = first-time-greeting flow, not pairing.
      await this.api.sendMessage({
        chat_id: input.chat.id,
        text: 'Hi! Ich bin der byte5 Harness Bot. Du kannst mich Sachen über deine Daten fragen.',
      });
      return;
    }

    const pending = this.pairingTokens.consume(input.token);
    if (!pending) {
      await this.api.sendMessage({
        chat_id: input.chat.id,
        text: 'Dieser Pairing-Link ist abgelaufen oder bereits verwendet. Bitte lass dir vom Operator einen neuen Link generieren.',
      });
      return;
    }

    const existing = await this.pairingStore.getDmBinding(input.from.id);
    if (existing && existing.harnessIdentityId !== pending.harnessIdentityId) {
      console.log(
        `[telegram] rebinding telegram_user=${String(input.from.id)} from harness=${existing.harnessIdentityId} to harness=${pending.harnessIdentityId}`,
      );
    }

    const binding = {
      telegramUserId: input.from.id,
      harnessIdentityId: pending.harnessIdentityId,
      harnessIdentityLabel: pending.harnessIdentityLabel,
      ...(input.from.username ? { telegramUsername: input.from.username } : {}),
      telegramDisplayName: telegramDisplayName(input.from),
      boundAt: new Date().toISOString(),
    };
    await this.pairingStore.putDmBinding(binding);

    console.log(
      `[telegram] dm pairing bound telegram_user=${String(input.from.id)} (@${input.from.username ?? 'no-username'}) → harness=${pending.harnessIdentityId} (${pending.harnessIdentityLabel})`,
    );

    await this.api.sendMessage({
      chat_id: input.chat.id,
      text: [
        '<b>Verbunden!</b>',
        '',
        `Du bist jetzt mit dem byte5 Harness verbunden als <b>${escapeHtml(pending.harnessIdentityLabel)}</b>.`,
        '',
        'Stell mir einfach eine Frage — ich antworte direkt.',
      ].join('\n'),
      parse_mode: 'HTML',
    });
  }

  private async handleCallbackQuery(
    cb: TelegramCallbackQuery,
  ): Promise<void> {
    if (!cb.message) {
      await this.api.answerCallbackQuery({ callback_query_id: cb.id });
      return;
    }
    const pending = this.renderer.takePendingCallback(
      cb.message.chat.id,
      cb.data,
    );
    // Acknowledge immediately so Telegram stops the loading spinner — even
    // if the token has already expired.
    await this.api.answerCallbackQuery({
      callback_query_id: cb.id,
      ...(pending ? {} : { text: 'Diese Auswahl ist abgelaufen.' }),
    });
    if (!pending) return;
    await this.runTurn({
      chat: cb.message.chat,
      from: cb.from,
      userMessage: pending.echo,
    });
  }

  private async runTurn(input: {
    chat: TelegramChat;
    from?: TelegramUser;
    userMessage: string;
    attachments?: Array<{
      kind: 'image' | 'file' | 'audio' | 'video';
      url: string;
      mediaType: string;
      name?: string;
      sizeBytes?: number;
      bytesBase64?: string;
    }>;
  }): Promise<void> {
    const sessionScope = `telegram:${String(input.chat.id)}`;
    const userId = input.from
      ? `telegram:${String(input.from.id)}`
      : undefined;

    const isGroup =
      input.chat.type === 'group' || input.chat.type === 'supergroup';
    const rosterProvider =
      isGroup && this.rosterProviderFactory
        ? this.rosterProviderFactory(input.chat.id)
        : undefined;

    const stopTyping = this.startTypingLoop(input.chat.id);
    const priorTurns = this.history.get(sessionScope);

    const run = async (): Promise<void> => {
      const attachCount = input.attachments?.length ?? 0;
      console.log(
        `[telegram] turn start chat=${String(input.chat.id)} type=${input.chat.type} user=${userId ?? 'anon'} history=${String(priorTurns.length)} roster=${rosterProvider ? 'on' : 'off'} attach=${String(attachCount)}`,
      );
      try {
        const result = await this.chatAgent.chat({
          userMessage: input.userMessage,
          sessionScope,
          ...(userId ? { userId } : {}),
          ...(priorTurns.length > 0
            ? {
                priorTurns: priorTurns.map((t) => ({
                  userMessage: t.userMessage,
                  assistantAnswer: t.assistantAnswer,
                })),
              }
            : {}),
          ...(input.attachments && input.attachments.length > 0
            ? { attachments: input.attachments }
            : {}),
          userTimeZone: 'Europe/Berlin',
        });

        if (isNoReply(result)) {
          logNoReplyDrop('telegram', {
            chatId: input.chat.id,
            userId,
            sessionScope,
          });
          return;
        }

        await this.renderer.renderAnswer(input.chat.id, result);

        // History append skipped for blocking `ask_user_choice` / slot-picker
        // turns — the "answer" there is a clarification prompt, not a real
        // response. Post-S+7.5: both are discriminated via `interactive.kind`.
        const isBlockingInteractive =
          result.interactive?.kind === 'choice' ||
          result.interactive?.kind === 'slots';
        if (!isBlockingInteractive) {
          this.history.append(sessionScope, {
            userMessage: input.userMessage,
            assistantAnswer: result.text,
            at: Date.now(),
          });
        }

        const attachmentCount = result.attachments?.length ?? 0;
        console.log(
          `[telegram] turn done (attach=${String(attachmentCount)}, history=${String(priorTurns.length + 1)}, chat=${String(input.chat.id)}, user=${userId ?? 'anon'})`,
        );
      } catch (err) {
        console.error('[telegram] orchestrator failure:', err);
        const detail = err instanceof Error ? err.message : String(err);
        await this.renderer.renderError(input.chat.id, detail);
      } finally {
        stopTyping();
      }
    };

    if (rosterProvider) {
      await this.turnContext.runWithChatParticipants(rosterProvider, run);
    } else {
      await run();
    }
  }

  // ---------- typing-loop helper --------------------------------------

  private startTypingLoop(chatId: number): () => void {
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      this.api
        .sendChatAction({ chat_id: chatId, action: 'typing' })
        .catch(() => {
          /* swallow — typing is best-effort */
        });
    };
    tick();
    const handle = setInterval(tick, 4_000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }
}

/**
 * Anthropic's vision API accepts only 4 image media types:
 * `image/jpeg`, `image/png`, `image/gif`, `image/webp`. Telegram's CDN
 * returns whatever the original upload was (HEIC from iPhone, TIFF from
 * scans, application/octet-stream for unknown). This normaliser:
 *   - returns the input as-is if it's one of the accepted 4
 *   - returns the fallback if input is undefined/empty
 *   - returns the fallback if input is `image/jpg` (alias) or
 *     `application/octet-stream` (Telegram defaults for re-encoded photos)
 *   - returns undefined for hard-rejects (non-supported image types)
 *     so the caller can decide to drop the attachment entirely
 */
type AnthropicImageMediaType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp';
function normaliseAnthropicMediaType(
  raw: string | undefined,
  fallback: 'image/jpeg',
): AnthropicImageMediaType;
function normaliseAnthropicMediaType(
  raw: string | undefined,
  fallback: undefined,
): AnthropicImageMediaType | undefined;
function normaliseAnthropicMediaType(
  raw: string | undefined,
  fallback: 'image/jpeg' | undefined,
): AnthropicImageMediaType | undefined {
  const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (!raw || raw.length === 0) return fallback;
  const lc = raw.toLowerCase().trim();
  if (ACCEPTED.has(lc)) return lc as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  // Common aliases that should map to a canonical accepted type.
  if (lc === 'image/jpg') return 'image/jpeg';
  if (lc === 'application/octet-stream') return fallback;
  // Hard-reject (HEIC, HEIF, TIFF, BMP, SVG, …) — caller drops attachment.
  return fallback;
}

function telegramDisplayName(user: {
  first_name: string;
  last_name?: string;
  username?: string;
}): string {
  const composed = [user.first_name, user.last_name]
    .filter((s): s is string => Boolean(s))
    .join(' ')
    .trim();
  if (composed.length > 0) return composed;
  return user.username ? `@${user.username}` : 'Telegram User';
}

