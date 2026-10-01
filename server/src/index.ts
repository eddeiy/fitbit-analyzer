import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { apiRoutes } from './api.js';
import { authRoutes } from './auth.js';
import { config, isOAuthConfigured } from './config.js';
import { markStaleRunsFailed } from './db.js';

const app = Fastify({ logger: { level: 'info' }, disableRequestLogging: true });

markStaleRunsFailed();
await app.register(authRoutes);
await app.register(apiRoutes);

// Serve the built PWA (npm run build) so it can be installed from http://localhost:<port>.
if (existsSync(config.webDist)) {
  await app.register(fastifyStatic, { root: config.webDist });
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    const isAppRoute = !path.startsWith('/api') && !path.startsWith('/auth') && !/\.[a-z0-9]+$/i.test(path);
    if (req.method === 'GET' && isAppRoute) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'Not found' });
  });
}

if (!isOAuthConfigured()) {
  app.log.warn('GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set - copy server/.env.example to server/.env');
}

await app.listen({ port: config.port, host: '127.0.0.1' });
