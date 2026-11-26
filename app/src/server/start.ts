import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { backendProvider } from './chat/backend.ts';
import { koboldCppProvider } from './chat/koboldcpp.ts';
import { ModelCatalog } from './chat/models.ts';
import { ModelProfiles } from './chat/profiles.ts';
import { openAIProvider } from './chat/openai.ts';
import { ReplyService } from './chat/replies.ts';
import type { AppConfig } from './config.ts';
import { engineJobs } from './engine/jobs.ts';
import { EngineSupervisor } from './engine/supervisor.ts';
import { VoiceWarmer } from './engine/warmer.ts';
import { LOOPBACK } from './loopback.ts';
import { SettingsStore } from './settings.ts';
import { CharacterStore } from './store/characters.ts';
import { ChatStore } from './store/chats.ts';
import { openDatabase } from './store/database.ts';
import { MediaStore } from './store/media.ts';
import { PlayerStore } from './store/players.ts';
import { ReplyPromptStore } from './store/replyPrompts.ts';
import { ScenarioStore } from './store/scenarios.ts';
import { SceneStore } from './store/scenes.ts';
import { Illustrator } from './scene/illustrator.ts';

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
  const characters = new CharacterStore(database);
  const scenarios = new ScenarioStore(database);
  const players = new PlayerStore(database);
  const replyPrompts = new ReplyPromptStore(database);
  const settings = new SettingsStore(
    path.join(config.dataDir, 'settings.json'),
    config.openai.apiKey,
  );
  const scenes = new SceneStore(database);
  const profiles = new ModelProfiles(
    path.join(config.dataDir, 'local-models.json'),
  );
  const koboldcpp = koboldCppProvider({
    address: () => settings.koboldcppAddress(),
    profile: (modelId) => profiles.profile(modelId),
  });
  // Only OpenAI is given the OpenAI key; KoboldCpp is given no key at all.
  const provider = backendProvider(() => settings.textBackend(), {
    openai: openAIProvider({
      baseUrl: config.openai.baseUrl,
      apiKey: () => settings.apiKey(),
    }),
    koboldcpp,
  });
  if (settings.textBackend() === 'koboldcpp') {
    // Found out now so the first reply need not wait for it. A failure is
    // reported by the first request instead.
    koboldcpp.loadedModel().catch(() => undefined);
  }
  const models = new ModelCatalog(
    path.join(config.dataDir, 'reasoning-levels.json'),
    provider,
  );
  const replies = new ReplyService(
    chats,
    characters,
    scenarios,
    players,
    replyPrompts,
    settings,
    provider,
  );
  const engine = new EngineSupervisor({
    ...config.engine,
    // The engine never calls OpenAI, so it is not given the key.
    env: { OPENAI_API_KEY: undefined },
  });
  const jobs = engineJobs(engine);
  const media = new MediaStore(config.dataDir);
  const illustrator = new Illustrator({
    chats,
    characters,
    scenarios,
    scenes,
    settings,
    provider,
    jobs,
    media,
  });
  // Pictures left behind by a run that ended part-way through making one.
  illustrator.prune();
  replies.onReplySaved((chatId, message) => {
    illustrator.afterReply(chatId, message.id);
  });
  const app = createApp({
    uiDir: config.uiDir,
    engine,
    jobs,
    warmer: new VoiceWarmer(engine, jobs),
    media,
    chats,
    characters,
    scenarios,
    players,
    replyPrompts,
    scenes,
    settings,
    models,
    koboldcpp,
    replies,
    illustrator,
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
