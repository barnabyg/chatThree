import { Hono } from 'hono';
import { characterRoutes } from './api/characters.ts';
import { chatRoutes } from './api/chats.ts';
import { engineRoutes } from './api/engine.ts';
import { modelRoutes } from './api/models.ts';
import { scenarioRoutes } from './api/scenarios.ts';
import { ApiError } from './api/errors.ts';
import { settingsRoutes } from './api/settings.ts';
import { speechRoutes } from './api/speech.ts';
import {
  ChatBusyError,
  ChatRequestError,
  type ReplyService,
} from './chat/replies.ts';
import type { ModelCatalog } from './chat/models.ts';
import type { EngineJobs } from './engine/jobs.ts';
import {
  IllustrationBusyError,
  IllustrationRequestError,
  type Illustrator,
} from './scene/illustrator.ts';
import type { EngineControl } from './engine/supervisor.ts';
import type { VoiceWarmer } from './engine/warmer.ts';
import { localOnly } from './localOnly.ts';
import type { SettingsStore } from './settings.ts';
import { staticFiles } from './staticFiles.ts';
import type { CharacterStore } from './store/characters.ts';
import type { ChatStore } from './store/chats.ts';
import type { MediaStore } from './store/media.ts';
import type { ScenarioStore } from './store/scenarios.ts';
import type { SceneStore } from './store/scenes.ts';

export interface AppDependencies {
  uiDir: string;
  engine: EngineControl;
  /** The jobs the engine does: speech and pictures. */
  jobs: EngineJobs;
  warmer: VoiceWarmer;
  /** The files that belong to characters. */
  media: MediaStore;
  chats: ChatStore;
  characters: CharacterStore;
  scenarios: ScenarioStore;
  /** Chats' places and illustrations. */
  scenes: SceneStore;
  settings: SettingsStore;
  /** The models that can write replies, and their thinking levels. */
  models: ModelCatalog;
  replies: ReplyService;
  illustrator: Illustrator;
}

/** The HTTP application: the JSON API under `/api`, the UI everywhere else. */
export function createApp(dependencies: AppDependencies): Hono {
  const {
    uiDir,
    engine,
    jobs,
    warmer,
    media,
    chats,
    characters,
    scenarios,
    scenes,
    settings,
    models,
    replies,
    illustrator,
  } = dependencies;
  const app = new Hono();
  app.use(localOnly);

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/engine', engineRoutes(engine));
  app.route(
    '/api/chats',
    chatRoutes({
      chats,
      characters,
      scenarios,
      scenes,
      replies,
      illustrator,
      settings,
      media,
    }),
  );
  app.route(
    '/api/characters',
    characterRoutes(characters, replies, media, warmer, jobs, illustrator),
  );
  app.route('/api/scenarios', scenarioRoutes(scenarios, replies, illustrator));
  app.route('/api/settings', settingsRoutes(settings));
  app.route('/api/models', modelRoutes(models));
  app.route('/api/speech', speechRoutes(jobs, characters, media));
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // Every API failure is `{ "error": "<message for the user>" }`.
  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof ChatBusyError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof ChatRequestError) {
      return c.json({ error: error.message }, 400);
    }
    if (error instanceof IllustrationBusyError) {
      return c.json({ error: error.message }, 409);
    }
    if (error instanceof IllustrationRequestError) {
      return c.json({ error: error.message }, 400);
    }
    // Only the error is logged, never the request: it may hold an API key.
    console.error(error);
    return c.json({ error: 'Something went wrong in chatThree.' }, 500);
  });

  app.use(staticFiles(uiDir));
  return app;
}
