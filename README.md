# chatThree

A local roleplay chat app. Two parts sit side by side:

- [`app/`](app): a TypeScript server and browser UI. The server listens on the
  loopback address only.
- [`engine/`](engine/README.md): a Python process that owns the GPU and runs the
  local speech and image models.

## Start it

Prerequisites: [Node.js](https://nodejs.org) 24.12 or newer and
[PowerShell 7](https://learn.microsoft.com/powershell/).

```powershell
cd C:\docs\git\chatThree; pwsh ./start.ps1
```

That installs the app's dependencies (first run, and whenever they change),
builds the UI, starts the server on <http://127.0.0.1:3210> and opens it in
your browser. Press Ctrl+C to stop.

| Option | Effect |
|---|---|
| `--port 4000` | Listen on another port (or set `CHATTHREE_PORT`) |
| `--no-open` | Do not open the browser |

## Check it

```powershell
cd C:\docs\git\chatThree; pwsh ./verify.ps1
```

One command runs every check for the engine and the app: formatting, lint,
type checking, unit tests, end-to-end tests, dependency audit and build. It
also needs [uv](https://docs.astral.sh/uv/), and downloads a headless browser
for the end-to-end tests the first time. It needs no GPU, model files or API
keys. CI runs the same script.
