import { Hono } from 'hono';
import { characterRoutes } from './api/characters.ts';
import { chatRoutes } from './api/chats.ts';
import { engineRoutes } from './api/engine.ts';
import { scenarioRoutes } from './api/scenarios.ts';
import { ApiError } from './api/errors.ts';
import { settingsRoutes } from './api/settings.ts';
import {
  ChatBusyError,
  ChatRequestError,
  type ReplyService,
} from './chat/replies.ts';
import type { EngineControl } from './engine/supervisor.ts';
import { localOnly } from './localOnly.ts';
import type { SettingsStore } from './settings.ts';
import { staticFiles } from './staticFiles.ts';
import type { CharacterStore } from './store/characters.ts';
import type { ChatStore } from './store/chats.ts';
import type { ScenarioStore } from './store/scenarios.ts';

export interface AppDependencies {
  uiDir: string;
  engine: EngineControl;
  chats: ChatStore;
  characters: CharacterStore;
  scenarios: ScenarioStore;
  settings: SettingsStore;
  replies: ReplyService;
}

/** The HTTP application: the JSON API under `/api`, the UI everywhere else. */
export function createApp(dependencies: AppDependencies): Hono {
  const { uiDir, engine, chats, characters, scenarios, settings, replies } =
    dependencies;
  const app = new Hono();
  app.use(localOnly);

  app.get('/api/health', (c) => c.json({ status: 'ok' }));
  app.route('/api/engine', engineRoutes(engine));
  app.route(
    '/api/chats',
    chatRoutes(chats, characters, scenarios, replies, settings),
  );
  app.route('/api/characters', characterRoutes(characters, replies));
  app.route('/api/scenarios', scenarioRoutes(scenarios, replies));
  app.route('/api/settings', settingsRoutes(settings));
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
    // Only the error is logged, never the request: it may hold an API key.
    console.error(error);
    return c.json({ error: 'Something went wrong in chatThree.' }, 500);
  });

  app.use(staticFiles(uiDir));
  return app;
}
