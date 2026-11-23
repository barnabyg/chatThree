import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_PORT = 3210;

export interface AppConfig {
  /** Port to listen on. 0 asks the operating system for a free one. */
  port: number;
  /** Directory holding the built browser UI. */
  uiDir: string;
  /** Open the UI in the default browser once the server is listening. */
  openBrowser: boolean;
  engine: {
    /** The engine's command line. The app adds `--port <n>`. */
    command: string[];
    cwd: string;
  };
}

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');

// `uv run` creates the engine's Python environment on first use.
const ENGINE_COMMAND = [
  'uv',
  'run',
  '--locked',
  '--no-dev',
  'python',
  '-m',
  'chatthree_engine.server',
];

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid port "${value}": expected a whole number from 0 to 65535.`,
    );
  }
  return port;
}

function parseCommand(value: string): string[] {
  const invalid = new Error(
    'CHATTHREE_ENGINE_COMMAND must be a JSON array of strings, for example ["uv","run","python","-m","chatthree_engine.server"].',
  );
  let command: unknown;
  try {
    command = JSON.parse(value);
  } catch {
    throw invalid;
  }
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === 'string')
  ) {
    throw invalid;
  }
  return command;
}

/** Build the configuration from command-line arguments and the environment. */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): AppConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
    },
  });
  const port = values.port ?? env.CHATTHREE_PORT;
  return {
    port: port === undefined ? DEFAULT_PORT : parsePort(port),
    uiDir: path.join(APP_ROOT, 'dist', 'ui'),
    openBrowser: !values['no-open'],
    engine: {
      command:
        env.CHATTHREE_ENGINE_COMMAND === undefined
          ? ENGINE_COMMAND
          : parseCommand(env.CHATTHREE_ENGINE_COMMAND),
      cwd: env.CHATTHREE_ENGINE_DIR ?? path.join(REPO_ROOT, 'engine'),
    },
  };
}
