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
}

const APP_ROOT = path.resolve(import.meta.dirname, '..', '..');

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(
      `Invalid port "${value}": expected a whole number from 0 to 65535.`,
    );
  }
  return port;
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
  };
}
