import { Hono } from 'hono';
import { localOnly } from './localOnly.ts';
import { staticFiles } from './staticFiles.ts';

export interface AppDependencies {
  uiDir: string;
}

/** The HTTP application: the JSON API under `/api`, the UI everywhere else. */
export function createApp({ uiDir }: AppDependencies): Hono {
  const app = new Hono();
  app.use(localOnly);
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use(staticFiles(uiDir));
  return app;
}
