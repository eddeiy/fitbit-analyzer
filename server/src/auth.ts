import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { config, isOAuthConfigured } from './config.js';
import { deleteTokens, getTokens, saveIdentity, saveTokens } from './db.js';
import { SCOPES } from './dataTypes.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const IDENTITY_URL = 'https://health.googleapis.com/v4/users/me/identity';

/** Refresh slightly before the 1 hour lifetime runs out. */
const EXPIRY_MARGIN_MS = 60_000;
const STATE_TTL_MS = 10 * 60_000;

const pendingStates = new Map<string, number>();

export class NotConnectedError extends Error {
  constructor(message = 'Not connected to Google Health. Connect or reconnect your account.') {
    super(message);
    this.name = 'NotConnectedError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      ...params,
    }),
  });
  const body = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    if (body.error === 'invalid_grant') {
      deleteTokens();
      throw new NotConnectedError('Google refresh token expired or was revoked. Please reconnect.');
    }
    throw new Error(`Token request failed: ${body.error} ${body.error_description ?? ''}`.trim());
  }
  return body;
}

function persist(t: TokenResponse) {
  saveTokens({
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiry: new Date(Date.now() + t.expires_in * 1000).toISOString(),
    scopes: t.scope,
  });
}

/** Returns a valid access token, refreshing it when needed. */
export async function getAccessToken(): Promise<string> {
  const tokens = getTokens();
  if (!tokens) throw new NotConnectedError();
  if (Date.parse(tokens.expiry) - EXPIRY_MARGIN_MS > Date.now()) {
    return tokens.access_token;
  }
  if (!tokens.refresh_token) throw new NotConnectedError('Access token expired and no refresh token stored.');
  const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  persist(refreshed);
  return refreshed.access_token;
}

export function connectionStatus() {
  const tokens = getTokens();
  return {
    configured: isOAuthConfigured(),
    connected: Boolean(tokens?.refresh_token),
    healthUserId: tokens?.health_user_id ?? null,
    legacyUserId: tokens?.legacy_user_id ?? null,
    scopes: tokens?.scopes.split(' ') ?? [],
    connectedAt: tokens?.updated_at ?? null,
  };
}

export async function authRoutes(app: FastifyInstance) {
  app.get('/auth/login', async (_req, reply) => {
    if (!isOAuthConfigured()) {
      return reply.code(500).send({ error: 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing in server/.env' });
    }
    const state = randomBytes(16).toString('hex');
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    const url = new URL(AUTH_URL);
    url.search = new URLSearchParams({
      client_id: config.googleClientId,
      redirect_uri: config.redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      scope: SCOPES.join(' '),
      state,
    }).toString();
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/callback', async (req, reply) => {
    const back = (status: string, message?: string) => {
      const url = new URL('/', config.webOrigin);
      url.searchParams.set('auth', status);
      if (message) url.searchParams.set('message', message);
      return reply.redirect(url.toString());
    };

    const { code, state, error } = req.query;
    const expires = state ? pendingStates.get(state) : undefined;
    if (state) pendingStates.delete(state);
    if (error) return back('error', error);
    if (!code || !expires || expires < Date.now()) return back('error', 'invalid_state');

    try {
      persist(await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }));
      const res = await fetch(IDENTITY_URL, {
        headers: { Authorization: `Bearer ${getTokens()!.access_token}`, Accept: 'application/json' },
      });
      if (res.ok) {
        const identity = (await res.json()) as { healthUserId?: string; legacyUserId?: string };
        saveIdentity(identity.healthUserId ?? null, identity.legacyUserId ?? null);
      } else {
        req.log.warn({ status: res.status, body: await res.text() }, 'identity lookup failed');
      }
      return back('success');
    } catch (err) {
      req.log.error(err, 'OAuth callback failed');
      return back('error', (err as Error).message);
    }
  });

  app.post('/auth/logout', async () => {
    const tokens = getTokens();
    if (tokens?.refresh_token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.refresh_token)}`, {
        method: 'POST',
      }).catch(() => undefined);
    }
    deleteTokens();
    return { ok: true };
  });
}
