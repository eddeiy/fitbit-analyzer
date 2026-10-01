import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = resolve(serverRoot, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing environment variable ${name} (see server/.env.example)`);
  }
  return value;
}

export const config = {
  googleClientId: env('GOOGLE_CLIENT_ID', ''),
  googleClientSecret: env('GOOGLE_CLIENT_SECRET', ''),
  redirectUri: env('OAUTH_REDIRECT_URI', 'http://localhost:3000/auth/callback'),
  webOrigin: env('WEB_ORIGIN', 'http://localhost:4200'),
  port: Number(env('PORT', '3000')),
  backfillDays: Number(env('BACKFILL_DAYS', '30')),
  dbPath: resolve(serverRoot, env('DB_PATH', '../data/health.db')),
  webDist: resolve(serverRoot, '../web/dist/web/browser'),
};

export const isOAuthConfigured = () => Boolean(config.googleClientId && config.googleClientSecret);
