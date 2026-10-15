import { app } from './app.js';
import { config, defaultProviderId, availableProviders } from './config.js';
import { pruneExpiredSessions } from './auth.js';
import { ready } from './db.js';
import { log } from './lib/util.js';

await ready;
await pruneExpiredSessions();
const cleanupTimer = setInterval(() => {
  pruneExpiredSessions().catch((error) => log('cleanup', error?.message || String(error)));
}, 60 * 60 * 1000);
cleanupTimer.unref();

const server = app.listen(config.port, config.host, () => {
  const providers = availableProviders();
  log('blue', `Project Blue v${config.version} listening on http://${config.host}:${config.port}`);
  log('blue', `engine: ${defaultProviderId()}  |  configured providers: ${providers.map((provider) => provider.id).join(', ')}`);
  log('blue', `web search: ${Object.entries(config.search).filter(([, value]) => value).map(([key]) => key).join(', ') || 'duckduckgo (keyless)'}`);
  log('blue', `database: ${config.databaseKind}  |  data dir: ${config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('blue', `${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

export { app, server };
