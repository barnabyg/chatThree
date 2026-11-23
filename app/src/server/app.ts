import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EngineStatus } from '../shared/api.ts';
import type { EngineControl } from './engine/supervisor.ts';
import { localOnly } from './localOnly.ts';
import { staticFiles } from './staticFiles.ts';

export interface AppDependencies {
  uiDir: string;
  engine: EngineControl;
}

function engineRoutes(engine: EngineControl): Hono {
  const routes = new Hono();

  routes.get('/', (c) => c.json(engine.status()));

  // A stream of status changes, starting with the current status, so the UI
  // follows the engine without reloading.
  routes.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      const send = (status: EngineStatus): void => {
        void stream.writeSSE({ event: 'status', data: JSON.stringify(status) });
      };
      send(engine.status());
      const unsubscribe = engine.subscribe(send);
      await new Promise<void>((resolve) => {
        stream.onAbort(resolve);
      });
      unsubscribe();
    }),
  );

  routes.post('/restart', async (c) => {
    await engine.restart();
    return c.json(engine.status());
  });

  return routes;
}

/** The HTTP application: the JSON API under `/api`, the UI everywhere else. */
export function createApp({ uiDir, engine }: AppDependencies): Hono {
  const app = new Hono();
  app.use(localOnly);
  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/engine', engineRoutes(engine));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
  app.use(staticFiles(uiDir));
  return app;
}
