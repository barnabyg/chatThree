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
only to the OpenAI API, and is never shown again. The model is also a setting.

The app starts with one character, Mara Quill, and one scenario, The Storm at
Gull Point. A chat pairs a character with a scenario: **New chat** asks for
both, and the sidebar lists every chat with its character, scenario and last
activity.

- **Characters**: a name, a persona, a speaking style, example dialogue and
  an appearance. The persona, speaking style and example dialogue go into the
  prompt; the appearance is what the character's reference picture is made
  from. A character can also be given a voice of its own: see
  [Speech](#speech).
- **Scenarios**: a title, a premise, the part you play (a name and a short
  description), an opening message and a starting location. The opening
  message becomes the character's first message in a new chat; the rest goes
  into the prompt after the character.

Both built-ins can be edited or deleted like any other. Deleting a character
or a scenario deletes the chats that use it, after asking.

A long chat is not sent whole. Each turn sends the character and scenario,
then as much of the conversation as fits a token budget (a setting, 16,000 by
default), counted back from the newest message. Older messages stay in the
chat, and a line in the conversation marks where sending now starts.

Chats and settings are kept on this computer, outside the repository:

| File | Holds |
|---|---|
| `%LOCALAPPDATA%\chatThree\chatthree.db` | Chats and messages (SQLite) |
| `%LOCALAPPDATA%\chatThree\settings.json` | The model, the speech settings and a saved API key |
| `%LOCALAPPDATA%\chatThree\voices\` | The characters' voice clips |
| `%LOCALAPPDATA%\chatThree\images\` | The characters' reference pictures |

Set `CHATTHREE_DATA_DIR` to keep them somewhere else. On macOS the default is
`~/Library/Application Support/chatThree`, and on Linux
`~/.local/share/chatthree`.

## Reference pictures

Each character can have a reference picture, which will keep the character
looking the same from scene to scene once scenes are illustrated. Edit the
character and, under **Picture**:

- **Generate picture** has the engine paint one from the appearance text as
  it reads in the editor at that moment, saved or not. It takes a few
  seconds.
- **Generate another** paints a different one from the same text, in place
  of the first. Change the appearance between tries to steer it.
- **Upload a picture** uses a PNG, JPEG or WebP image of your own instead.

The picture is saved as soon as it is made or chosen, is shown in the editor
and beside the character in the list, and is kept in the app's data folder.
If the engine is not ready, generating says so; uploading and the rest of
the editor do not need the engine.

## Speech

Replies are spoken aloud as they arrive, by the engine: in the character's own
voice if it has one, and otherwise in the engine's built-in voice.
The engine returns each clip whole, so the app splits the reply into sentences
as it streams in, has each one spoken, and plays the clips in order: the first
sentence is heard while the rest is still being written.

- **Speak replies** in a chat's header turns speech off and on. The choice is
  saved, and is also in **Settings**.
- **Stop** ends the reply and what is being said. Once the reply has all
  arrived, **Stop speaking** ends only the speech.
- **Settings > What is spoken** chooses between only what the character says
  (the default) and the whole reply. What the character says is the text in
  double quotation marks. A reply with no quotation marks that marks its actions
  with `*asterisks*`, as the built-in character's do, is written the other way
  round: there, everything outside the asterisks is spoken. A reply with
  neither is spoken whole, once it has all arrived.
- Formatting marks such as asterisks are never spoken, and a sentence longer
  than the engine takes in one request (600 characters) is split first.

To give a character a voice, edit the character and choose a recording under
**Voice**: one person speaking clearly, for more than 5 seconds. The engine
clones the voice from it. The browser reads the recording (WAV, MP3, M4A and
whatever else it can play), keeps the first 30 seconds as a mono WAV file,
and the app stores that in its data folder. A recording of 5 seconds or less
is refused. The clip is saved as soon as it is chosen; choosing another
replaces it, **Remove voice clip** goes back to the built-in voice, and
**Preview voice** speaks a sample line. Opening a chat has the engine prepare
the character's voice, so the first sentence is not held up by the cloning,
which takes about 2.5 seconds.

Text chat does not depend on speech. If the engine is not ready, or cannot
speak a sentence, the reply still arrives and the chat says that speech is
unavailable.

## Configuration

Everything works without any of these. They are read when the app starts.

| Variable | Effect |
|---|---|
| `OPENAI_API_KEY` | The API key, unless one is saved in Settings |
| `OPENAI_BASE_URL` | Where replies are requested, in place of `https://api.openai.com/v1`. The API key is sent there, so point it only at a server you trust. The tests point it at a fake |
| `CHATTHREE_PORT` | The port to listen on, in place of 3210 |
| `CHATTHREE_DATA_DIR` | Where chats and settings are kept |
| `CHATTHREE_ENGINE_COMMAND` | The engine's command line as a JSON array of strings, in place of `uv run ... chatthree_engine.server`. The app adds `--port <n>`. The tests run a fake engine this way |
| `CHATTHREE_ENGINE_DIR` | The directory the engine is started in, in place of `engine/` |

## Known gaps

- **A killed app leaves the engine running.** Stopping the app with Ctrl+C,
  or by closing its window, ends the engine. Killing the app's process
  outright (Task Manager, `Stop-Process`) gives it no chance to, and the
  engine keeps the GPU until it is ended by hand:
  `Get-CimInstance Win32_Process | Where-Object CommandLine -like '*chatthree_engine*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`
- **Token counts are estimates.** The conversation budget counts four
  characters as a token, which suits English prose and undercounts some
  other languages.

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

## Manual check: spoken replies

Needs the real engine, so a GPU, and speakers or headphones.

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Wait until the page shows **Engine ready**.
3. Choose **New chat**, then **Start chat**, and send
   `Is it always this rough out here?`
4. Expect to hear the reply in the engine's built-in voice, starting while
   the text is still arriving. The sentences come in order and do not
   overlap. The actions between asterisks are not read out.
5. Send another message and, while it is being spoken, choose **Stop
   speaking** (or **Stop** if the reply is still arriving). Expect the sound
   to end at once and not to resume.
6. Untick **Speak replies** and send a message. Expect silence. Reload the
   page: the box is still unticked.
7. Tick **Speak replies** again. In **Settings**, set **What is spoken** to
   **The whole reply** and save. Back in the chat, send a message. Expect the
   actions to be read out as well, and the word "asterisk" never to be said.

## Manual check: a cloned voice

Needs the real engine, speakers or headphones, and a recording of someone
speaking: any WAV, MP3 or M4A file of 10 to 30 seconds with one clear voice
and little background noise.

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Wait until the page shows **Engine ready**.
3. Choose **Characters**, then **Edit** on Mara Quill. Under **Voice**,
   choose **Preview voice**. Expect the sample line in the engine's built-in
   voice.
4. Under **Voice clip**, choose your recording. Expect the text above it to
   change to say that replies are spoken in the cloned voice.
5. Choose **Preview voice** again. Expect the sample line in a voice that
   resembles the recording, after a pause of a few seconds while the voice
   is cloned.
6. Choose **Characters**, then **Chat** on Mara Quill, then **Start chat**,
   wait about 5 seconds and send a message. Expect the reply in the cloned
   voice, with the first sentence starting as promptly as the later ones.
7. Edit Mara Quill again and choose a recording shorter than 5 seconds.
   Expect a message saying how long the recording is and that it must be
   longer than 5 seconds; the earlier clip is still in use.
8. Choose **Remove voice clip**, then **Preview voice**. Expect the built-in
   voice again, and `%LOCALAPPDATA%\chatThree\voices` to be empty.

## Manual check: a reference picture

Needs the real engine, so a GPU.

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Wait until the page shows **Engine ready**.
3. Choose **Characters**, then **Edit** on Mara Quill. Under **Picture**,
   choose **Generate picture**. Expect, within about 10 seconds, a portrait
   that fits the appearance text: a weathered woman in her fifties with
   grey-streaked dark hair, in a heavy jumper.
4. Choose **Generate another**. Expect a visibly different picture of the
   same description to take its place.
5. Change the appearance to `A young man with red hair and a green scarf.`
   and, without saving, choose **Generate another**. Expect a picture of
   that description.
6. Reload the page. Expect the last picture still to be shown, and the
   appearance text to be the original (it was not saved).
7. Under **Upload a picture**, choose any PNG or JPEG image. Expect it to
   take the generated picture's place.
8. Choose **Characters**. Expect the picture beside Mara Quill, and exactly
   one file in `%LOCALAPPDATA%\chatThree\images`.

## Check it

```powershell
cd C:\docs\git\chatThree; pwsh ./verify.ps1
```

One command runs every check for the engine and the app: formatting, lint,
type checking, unit tests, end-to-end tests, dependency audit and build. It
also needs [uv](https://docs.astral.sh/uv/), and downloads a headless browser
for the end-to-end tests the first time. It needs no GPU, model files or API
keys. CI runs the same script.
