import { createExpressApp, startServer } from './src/server';

startServer().catch((err) => {
  console.error('[SERVER STARTUP ABORTED] Migrazione o avvio fallito:', err);
  process.exit(1);
});

export { createExpressApp, startServer };
