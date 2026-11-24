import { loadConfig } from './config.ts';
import { openBrowser } from './openBrowser.ts';
import { startApp } from './start.ts';

async function main(): Promise<void> {
  const config = loadConfig(process.argv.slice(2), process.env);
  const app = await startApp(config);

  let stopping: Promise<void> | undefined;
  const shutdown = (): void => {
    stopping ??= app.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(error);
        process.exit(1);
      },
    );
  };
  // SIGHUP is a closed console window and SIGBREAK is Ctrl+Break on Windows.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
    process.on(signal, shutdown);
  }
  // A parent process that started the app with an IPC channel (the end-to-end
  // tests do) can ask it to stop, and it stops if that parent goes away.
  // Windows has no signal a parent can send for a clean stop.
  process.on('message', (message) => {
    if (message === 'shutdown') shutdown();
  });
  process.on('disconnect', shutdown);

  console.log(`chatThree is running at ${app.url}`);
  console.log('Press Ctrl+C to stop.');
  if (config.openBrowser) openBrowser(app.url);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
