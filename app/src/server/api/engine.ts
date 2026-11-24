import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EngineStatus } from '../../shared/api.ts';
import type { EngineControl } from '../engine/supervisor.ts';

export function engineRoutes(engine: EngineControl): Hono {
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
