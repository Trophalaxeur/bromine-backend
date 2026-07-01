import { OAuth2Client } from 'google-auth-library';
import { config } from '../config.ts';

const client = new OAuth2Client(config.googleClientId);

export interface AuthenticatedUser {
  email: string;
}

/** Verifies a Google id_token against Google's JWKS (handled internally by
 *  google-auth-library) and checks the email allowlist. Throws on any failure —
 *  callers should map that to a 401. */
export async function verifyGoogleIdToken(idToken: string): Promise<AuthenticatedUser> {
  const ticket = await client.verifyIdToken({ idToken, audience: config.googleClientId });
  const payload = ticket.getPayload();
  if (!payload?.email) throw new Error('Google id_token payload has no email');

  const email = payload.email.toLowerCase();
  if (!config.allowedEmails.includes(email)) throw new Error(`Email not authorized: ${email}`);

  return { email };
}
