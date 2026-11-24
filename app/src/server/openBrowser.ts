import { spawn } from 'node:child_process';

function launcher(url: string): [command: string, args: string[]] {
  switch (process.platform) {
    case 'win32':
      return ['rundll32', ['url.dll,FileProtocolHandler', url]];
    case 'darwin':
      return ['open', [url]];
    default:
      return ['xdg-open', [url]];
  }
}

/** Open `url` in the default browser. Failing to is not an error: the URL is also printed. */
export function openBrowser(url: string): void {
  const [command, args] = launcher(url);
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}
