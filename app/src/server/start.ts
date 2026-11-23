import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import type { AppConfig } from './config.ts';
import { EngineSupervisor } from './engine/supervisor.ts';

export const LOOPBACK = '127.0.0.1';

export interface RunningApp {
  url: string;
  /** Stop serving and end everything the app started, including the engine. */
  stop(): Promise<void>;
}

/** Start the app and resolve once it is listening. The engine loads in the background. */
export async function startApp(config: AppConfig): Promise<RunningApp> {
  const engine = new EngineSupervisor({
    ...config.engine,
    // The engine never calls OpenAI, so it is not given the key.
    env: { OPENAI_API_KEY: undefined },
  });
  const app = createApp({ uiDir: config.uiDir, engine });
  const server = serve({
    fetch: app.fetch,
    hostname: LOOPBACK,
    port: config.port,
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `Port ${String(config.port)} is already in use. chatThree may already be running; otherwise choose another port with --port.`,
            )
          : error,
      );
    });
  });
  const { port } = server.address() as AddressInfo;
  await engine.start();

  return {
    url: `http://${LOOPBACK}:${String(port)}`,
    async stop() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        // Long-lived connections (event streams) would otherwise hold the server open.
        if ('closeAllConnections' in server) server.closeAllConnections();
      });
      // The engine must be ended even if closing the server fails.
      await Promise.allSettled([closed, engine.stop()]);
      await closed;
    },
  };
}
