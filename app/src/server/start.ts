import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { openAIProvider } from './chat/openai.ts';
import { ReplyService } from './chat/replies.ts';
import type { AppConfig } from './config.ts';
import { EngineSupervisor } from './engine/supervisor.ts';
import { SettingsStore } from './settings.ts';
import { ChatStore } from './store/chats.ts';
import { openDatabase } from './store/database.ts';

export const LOOPBACK = '127.0.0.1';

export interface RunningApp {
  url: string;
  /** Stop serving and end everything the app started, including the engine. */
  stop(): Promise<void>;
}

/** Start the app and resolve once it is listening. The engine loads in the background. */
export async function startApp(config: AppConfig): Promise<RunningApp> {
  mkdirSync(config.dataDir, { recursive: true });
  const database = openDatabase(path.join(config.dataDir, 'chatthree.db'));
  const chats = new ChatStore(database);
  const settings = new SettingsStore(
    path.join(config.dataDir, 'settings.json'),
    config.openai.apiKey,
  );
  const replies = new ReplyService(
    chats,
    settings,
    openAIProvider({
      baseUrl: config.openai.baseUrl,
      apiKey: () => settings.apiKey(),
    }),
  );
  const engine = new EngineSupervisor({
    ...config.engine,
    // The engine never calls OpenAI, so it is not given the key.
    env: { OPENAI_API_KEY: undefined },
  });
  const app = createApp({
    uiDir: config.uiDir,
    engine,
    chats,
    settings,
    replies,
  });
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
      // End replies in progress so that what they have written is saved.
      await replies.stopAll();
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
      database.close();
      await closed;
    },
  };
}
