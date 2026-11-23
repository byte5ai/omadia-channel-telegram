import { randomBytes } from 'node:crypto';

/** Vault key of the admin token; also the key of its secret setup field. */
export const ADMIN_TOKEN_KEY = 'telegram_admin_token';

interface SecretStore {
  get(key: string): Promise<string | undefined>;
  set?: (key: string, value: string) => Promise<void>;
}

/**
 * The bearer token of the admin router. An operator sets it as a secret setup
 * field (it lands in the vault under {@link ADMIN_TOKEN_KEY}); without one a
 * random token is generated and kept in the vault. The value is never logged:
 * an operator who wants the admin UI sets their own token in the plugin
 * settings, which also rotates it.
 */
export async function ensureAdminToken(
  secrets: SecretStore,
  log: (line: string) => void,
): Promise<string | undefined> {
  const stored = (await secrets.get(ADMIN_TOKEN_KEY))?.trim();
  if (stored) return stored;
  if (!secrets.set) return undefined;
  const generated = randomBytes(32).toString('hex');
  await secrets.set(ADMIN_TOKEN_KEY, generated);
  log(
    `${ADMIN_TOKEN_KEY} generated and stored in the plugin vault (not logged). To use the admin UI, set your own token in the plugin settings (field "Admin-Token"); that also rotates it.`,
  );
  return generated;
}
