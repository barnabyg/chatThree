# chatThree

A local roleplay chat app. Two parts sit side by side:

- [`app/`](app): a TypeScript server and browser UI. The server listens on the
  loopback address only.
- [`engine/`](engine/README.md): a Python process that owns the GPU and runs the
  local speech and image models.

## Start it

Prerequisites: [Node.js](https://nodejs.org) 24.12 or newer,
[PowerShell 7](https://learn.microsoft.com/powershell/), and for the engine
[uv](https://docs.astral.sh/uv/) and an NVIDIA GPU with 24 GB of VRAM.

```powershell
cd C:\docs\git\chatThree; pwsh ./start.ps1
```

That installs the app's dependencies (first run, and whenever they change),
builds the UI, starts the server on <http://127.0.0.1:3210> and opens it in
your browser. Press Ctrl+C to stop.

Starting the app also starts the engine, on a port the app chooses; there is
no separate step. The UI shows the engine as loading, ready or failed, and
offers a restart when it has failed. The first run downloads about 18 GB of
models, and later starts take about 45 seconds to reach ready. The app works
without the engine: if uv or the GPU is missing, the UI says so. Stopping the
app ends the engine's whole process tree.

| Option | Effect |
|---|---|
| `--port 4000` | Listen on another port (or set `CHATTHREE_PORT`) |
| `--no-open` | Do not open the browser |

## Chat

Replies come from OpenAI, so chat needs an OpenAI API key. Either set
`OPENAI_API_KEY` before starting the app, or paste a key into **Settings**. A
key saved in Settings is used in place of the environment variable, is sent
only to OpenAI, and is never shown again. The model is also a setting.

Chats and settings are kept on this computer, outside the repository:

| File | Holds |
|---|---|
| `%LOCALAPPDATA%\chatThree\chatthree.db` | Chats and messages (SQLite) |
| `%LOCALAPPDATA%\chatThree\settings.json` | The model and a saved API key |

Set `CHATTHREE_DATA_DIR` to keep them somewhere else. On macOS the default is
`~/Library/Application Support/chatThree`, and on Linux
`~/.local/share/chatthree`.

## Manual check: the engine stops with the app

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Wait until the page shows **Engine ready**.
3. In a second terminal, run
   `nvidia-smi --query-gpu=memory.used --format=csv`. Expect about 14 to 16 GB
   in use.
4. Press Ctrl+C in the first terminal.
5. Run the `nvidia-smi` command again. Expect the figure to be back to what
   the desktop alone uses (about 1.5 GB), and this to print nothing:
   `Get-CimInstance Win32_Process | Where-Object CommandLine -like '*chatthree_engine*'`

## Check it

```powershell
cd C:\docs\git\chatThree; pwsh ./verify.ps1
```

One command runs every check for the engine and the app: formatting, lint,
type checking, unit tests, end-to-end tests, dependency audit and build. It
also needs [uv](https://docs.astral.sh/uv/), and downloads a headless browser
for the end-to-end tests the first time. It needs no GPU, model files or API
keys. CI runs the same script.
