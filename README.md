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

On Windows you can instead double-click `run.bat` in the repository folder. It
runs `start.ps1` with the same options, and keeps its window open if starting
fails so you can read the error.

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

Replies come from the **text backend**, chosen in **Settings > Connection**:
OpenAI, the default, or a local model served by
[KoboldCpp](#local-text-with-koboldcpp). With OpenAI, chat needs an OpenAI
API key. Either set
`OPENAI_API_KEY` before starting the app, or paste a key into **Settings**. A
key saved in Settings is used in place of the environment variable, is sent
only to the OpenAI API, and is never shown again.

The model is also a setting, picked from the chat models your key can use (the
app asks OpenAI for its model list and leaves out the ones for pictures, sound,
search and code, and dated snapshots). Each model also has a **thinking
level**: how long it thinks before it answers. OpenAI does not say which levels
a model takes, so the first time a model is chosen the app finds out with up to
a few tiny requests, and keeps the answer for a month in
`reasoning-levels.json` in the data directory. If the model list cannot be
loaded (no key, no network), the model is typed instead.

The app starts with one character, Mara Quill, one scenario, The Storm at
Gull Point, and one player, The Traveller. A chat pairs a character with a
scenario, played as one of your players or as no one, with a reply prompt:
**New chat** asks for all four, and the sidebar lists every chat with its character, scenario and
last activity.

- **Characters**: a name, a persona, a speaking style, example dialogue and
  an appearance. The persona, speaking style and example dialogue go into the
  prompt; the appearance is what the character's reference picture is made
  from. A character can also be given a voice of its own: see
  [Speech](#speech).
- **Scenarios**: a title, a premise, an opening message and a starting
  location. The opening message becomes the character's first message in a
  new chat; the rest goes into the prompt after the character.
- **Players**: who you play, as a name and a background, chosen per chat so
  the same player can go into any scenario. The player goes into the prompt
  as the part the user plays. A scenario made before players existed had
  this part in it; it became a player, and that scenario's chats are played
  as it.
- **Reply prompts** (in **Settings > Reply prompts**): the "How to reply"
  section at the end of the prompt, with a name. **Default** is built in and cannot be changed:
  it tells the character to reply only as themself and never act for the
  user. Your own start as a copy of it. `{character}` in a reply prompt
  becomes the character's name, and `{user}` the player's, or "the user" in
  a chat with no player. A chat keeps the reply prompt it was started with,
  and follows edits to it; deleting one puts its chats back on Default.

The built-ins can be edited or deleted like any other. Deleting a character,
scenario or player deletes the chats that use it, after asking.

A long chat is not sent whole. Each turn sends the character and scenario,
then as much of the conversation as fits a token budget (a setting, 16,000 by
default), counted back from the newest message. Older messages stay in the
chat, and a line in the conversation marks where sending now starts. With
KoboldCpp, the budget comes from the loaded model instead (see
[Conversation budget with KoboldCpp](#conversation-budget-with-koboldcpp)).

Chats and settings are kept on this computer, outside the repository:

| File | Holds |
|---|---|
| `%LOCALAPPDATA%\chatThree\chatthree.db` | Chats and messages (SQLite) |
| `%LOCALAPPDATA%\chatThree\settings.json` | The text backend, the models, the speech settings and a saved API key |
| `%LOCALAPPDATA%\chatThree\local-models.json` | Your overrides of local models' profiles, if any (see [Model profiles](#model-profiles)) |
| `%LOCALAPPDATA%\chatThree\voices\` | The characters' voice clips |
| `%LOCALAPPDATA%\chatThree\images\` | The characters' reference pictures |
| `%LOCALAPPDATA%\chatThree\scenes\` | Illustrations of chats |
| `%LOCALAPPDATA%\chatThree\locations\` | Reference pictures of the places in chats |

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
A new character can be given an uploaded picture before it is first saved;
the picture is held until **Save character** and saved with it. Generating
needs a saved character.
If a picture is uploaded while another is being generated, the uploaded one
is kept.

## Local text with KoboldCpp

With **Text backend** set to **KoboldCpp**, the replies and the scene call are
written by the model loaded in KoboldCpp, usually on another PC on your
network, so the engine keeps this PC's VRAM for pictures and voices. No OpenAI
key is needed, and the OpenAI key is never sent to KoboldCpp.

- **Server address**: where KoboldCpp listens, such as
  `http://192.168.1.50:5001`. The app adds the paths itself. Start KoboldCpp
  with `--host 0.0.0.0` so that other PCs can reach it, and use the PC's IPv4
  address: a `.local` name can resolve to an IPv6 address KoboldCpp does not
  listen on.
- **Test connection** shows the loaded model and its context length, or why
  KoboldCpp could not be reached.
- **Loaded model**: the model KoboldCpp has loaded, read-only. The app asks
  KoboldCpp at startup, when the connection settings are saved or tested, and
  after a failed request. To use another model, load it in KoboldCpp and save
  or test the connection. The OpenAI model and scene model settings are hidden
  and kept for when OpenAI is chosen again.

KoboldCpp applies the model's chat template; the app sends the instructions as
a system message, then the conversation. A password (`--password`) is not
supported: start KoboldCpp without one. Chats cross the network unencrypted
over plain HTTP. The choice takes effect on the next request, without a
restart; settings saved before the choice existed load as OpenAI.

KoboldCpp works on one request at a time and queues the rest. **Stop**, and
anything else that ends a reply early (regenerating, closing the app), also
asks KoboldCpp to stop generating, so that it is free for the next request.
A reply comes first: if the scene call that follows the last reply is still
running when you send a message, it is given up (that reply is then not
followed or illustrated), so the reply does not wait for it. A scene call you
asked for with **Illustrate** is not given up; a reply sent meanwhile waits
for it.

### Conversation budget with KoboldCpp

With KoboldCpp, how much of a conversation is sent follows the loaded model's
context length, and the **Conversation budget** setting is hidden (it still
applies to OpenAI). The conversation gets the context length (the profile's
`contextLength`, or else what KoboldCpp reports), less the reply's
`maxReplyTokens`, less the instructions, less a margin of 64 tokens and 10
tokens a message for the chat template's own marks. Each text is counted once
by KoboldCpp's tokeniser (`/api/extra/tokencount`) and the count remembered.

KoboldCpp reuses its work on the prompt only as far as the prompt starts the
same as the last one. When the oldest message sent drops out, it reads the
whole prompt again: about 5 seconds before the first word for 6,000 tokens on
the PC it was measured on, against under a second when the prompt only grows.
So once the conversation fills its budget, a block of old messages, at least a
quarter of the budget, stops being sent at once. Where sending starts then
stays put for several turns, and the line in the chat moves with it.

### Thinking models

A thinking model, such as Qwen3 or a DeepSeek R1 distill, writes its reasoning
before the reply. That reasoning is never shown, saved or spoken: while the
model thinks, the chat shows **Thinking…** in place of the reply.

KoboldCpp usually sends the thinking apart from the reply, and the app leaves
it out whatever the profile says. For a model whose profile has `thinking`
set to `strip`, the app also drops anything between the open and close tags
(`<think>` and `</think>` by default) at the start of the reply, as it
arrives, on the server. If the reply has a close tag but no open tag (some
templates open the thinking in the prompt), everything before the close tag
is dropped. So a reply with neither tag is held back until a close tag
comes, the reply ends, or 1,500 characters have arrived, after which it is
taken as a reply without thinking and streams as usual: a model given a
thinking preset that does not think only starts a little later. A reply that is all thinking, cut off by its length limit
or by **Stop**, counts as empty. With `thinking` set to `none`, the reply is
passed on unchanged, tags and all.

### Model profiles

Local models differ in what they need, so each model KoboldCpp loads gets a
**model profile**: a **preset** that ships with the app, with your own
**overrides** on top. A model seen for the first time gets its preset, with
nothing to set up.

The preset is chosen by the model's id, as KoboldCpp gives it (`koboldcpp/`
and the GGUF file's name), ignoring case and the quantisation suffix such as
`-Q4_K_M`. The first match wins:

| Preset | Matches ids with | Notes |
|---|---|---|
| DeepSeek R1 distill | `deepseek-r1` | Instructions in the first user message, not a system message; a thinking model, given more reply tokens |
| Qwen3 | `qwen3` | A thinking model, given more reply tokens, as thinking counts against them |
| Mistral | `mistral` or `nemo` | |
| Gemma | `gemma` | |
| Llama 3 | `llama-3`, `llama3` | |
| Generic | anything | |

Each profile has these fields:

| Field | Use |
|---|---|
| `contextLength` | The context length to plan for; `null` means what KoboldCpp reports. The conversation budget comes from it |
| `maxReplyTokens` | `max_tokens` on replies |
| `temperature`, `top_p`, `top_k`, `min_p`, `rep_pen`, `rep_pen_range` | Samplers on replies |
| `sceneTemperature` | The temperature of the scene call, low by default |
| `stop` | Stop sequences on replies. `{user}` and `{character}` are filled in as in reply prompts. By default the reply stops where the model starts a line with your player's name and a colon |
| `systemRole` | `system`, or `merge-into-first-user` for a chat template without a system role |
| `thinking` | `{"mode": "none"}`, or `{"mode": "strip", "open": "<think>", "close": "</think>"}`: see [Thinking models](#thinking-models) |
| `extraBody` | A JSON object merged into every request, for KoboldCpp fields the app does not know about. It cannot change the model, the messages, streaming or the response format |

#### The profile editor

**Settings > Text**, while the text backend is KoboldCpp, edits the loaded
model's profile, so that tuning a model needs no file editing. It shows the
loaded model's id, the preset its name matched, and every field with the
value in use.

- A field you have changed is marked **Changed**, with a **Reset** that puts
  the preset's value back. **Reset all** clears every change for the model at
  once.
- **Preset** can be chosen by hand, for a model whose name matches no preset
  that suits it. Fields you have not changed follow the chosen preset.
- **Stop sequences** are a list: **Add stop sequence**, or **Remove** one.
  Write a new line as `\n`.
- **Extra request fields** is JSON, checked when you save.
- A value out of range, or JSON that is not an object, is refused with a
  message at its field, by the page and again by the server.
- **Save profile** saves this model's changes only, apart from the other
  settings; other models' entries in the file are left as they are. A change
  applies from the next reply.

The editor saves to the same file, which can still be edited by hand.

#### Editing the file

To change a field for one model, put it in `local-models.json` in the data
directory (`%LOCALAPPDATA%\chatThree\local-models.json`), under the model's
id exactly as **Test connection** shows it. Only the fields you change belong
there, so a better preset in a later version still reaches the rest.
`"preset"` names a preset to use in place of the one matched. For example:

```json
{
  "koboldcpp/Qwen3.8-27B-Uncensored-Q4_K_M": {
    "temperature": 0.8,
    "maxReplyTokens": 1024,
    "extraBody": { "reasoning_effort": "none" }
  }
}
```

(`"reasoning_effort": "none"` is the one way found to cut a Qwen3 model's
thinking short in KoboldCpp; a line of thinking is still written.) An edit
takes effect on the next request. A field that is not valid is ignored with
a warning in the app's console, and so is the whole file if it is not valid
JSON.

## Illustrations

Every message of the character's has an **Illustrate** button, which paints
a picture of that moment under the message. It takes two steps:

- A second, small request to the text backend (the *scene call*) reads the
  latest messages, up to the one illustrated, and describes the moment as a
  picture: what the character is doing, their expression, the framing and
  the light. With OpenAI, its model is **Settings > Images > Scene model**,
  `gpt-5-mini` unless changed. With KoboldCpp, it is the loaded model, which
  is held to the answer's JSON schema; if KoboldCpp will not be held to it,
  the JSON is described in the instructions instead. Either way the answer is
  checked, found inside prose, a code fence or after a thinking block, and
  asked for once more if it does not fit. A second answer that does not fit
  fails, with **Try again**.
- The engine paints the scene from that description and two reference
  pictures: the character's, and one of the place the scene is in.

The scene call also says where the moment takes place, so that pictures
follow the story. A chat begins at its scenario's starting location (or, if
that was left blank, its premise). When the scene call reports somewhere
new, the chat adds that place, with the name and description the call gave
it; when it reports a place the story has already been, by name, the chat
goes back to it. Illustrating the character's latest message moves the
chat there; an earlier message is pictured where it took place, without
moving the chat. A place's reference picture is painted the first time an
illustration there needs it, and reused after that.

**Settings > Images > Picture style** decides how scenes and places look:
**Realistic** (the default) asks for photographs, **Illustration** for
painted illustrations. Pictures already painted keep their style. A place's
picture is a reference for every scene there, so after changing the style,
use **Generate another** on a place to bring its scenes fully into the new
style.

The chat's header shows where the story is now. **Locations** lists every
place the chat has been, with its reference picture; **Generate another**
paints a place's picture again, and later illustrations there use the new
one.

The message shows how far the picture has got, and speech carries on while
it is painted. Choosing a picture opens it at full size. Pictures are kept
with the chat, in the app's data folder; deleting a message or a chat, or
regenerating a reply, deletes its pictures. If the scene call or the engine
fails, the message says why and offers **Try again**; the chat carries on
either way.

Illustrating needs the character's reference picture (see
[Reference pictures](#reference-pictures)). Without one, **Illustrate** says
so and links to the character.

Pictures also arrive without being asked. After each reply the scene call
runs by itself: it follows the story to where the reply takes place, and
says whether the moment is worth a picture. **Settings > Images > Illustrate replies
by themselves** decides what happens then:

| Mode | A reply is illustrated when |
|---|---|
| Off | Never. The scene call still runs, so the chat still follows the story |
| Scene changes only | The story moves somewhere else |
| Key moments (the default) | The story moves somewhere else, or the scene call says the moment is worth it and at least the cooldown's number of replies (**Settings > Images > Cooldown**, 3 unless changed) have passed since the last picture |
| Every reply | Always |

**Illustrate** works in every mode, and restarts the cooldown. A character
without a reference picture is not illustrated by itself. A scene call that
fails after a reply is logged in the app's console and that reply is not
illustrated; the reply itself is never affected. The engine paints one
picture at a time, and a chat has at most one automatic picture waiting:
a newer one takes the place of one that has not started.

## Speech

Replies are spoken aloud as they arrive, by the engine: in the character's own
voice if it has one, and otherwise in the engine's built-in voice.
The engine returns each clip whole, so the app splits the reply into sentences
as it streams in, has each one spoken, and plays the clips in order: the first
sentence is heard while the rest is still being written.

- **Speak replies** in a chat's header turns speech off and on. The choice is
  saved, and is also in **Settings > Speech**.
- **Stop** ends the reply and what is being said. Once the reply has all
  arrived, **Stop speaking** ends only the speech.
- **Settings > Speech > What is spoken** chooses between only what the character says
  (the default) and the whole reply. Characters are written in two ways, and
  the app goes by which one a reply uses:
  - `She nods. "Come in," she says.` Speech is in double quotation marks,
    and only that is spoken.
  - `*She nods.* Come in.` Actions are between asterisks, as the built-in
    character's are, and everything else is spoken.

  A word stressed with asterisks (`I do *not* want that`) and a title or
  single word in quotation marks (`Have you read "Dune"?`) are part of the
  text around them, not an action or a line of dialogue. A reply with
  neither quotation marks nor actions is spoken whole. The character's
  previous message gives a head start on which way a reply is written;
  without one, speech starts at the reply's first quotation or action, or
  at its end if it has neither.
- Formatting marks such as asterisks are never spoken, and a sentence longer
  than the engine takes in one request (600 characters) is split first.
- The speaker icon beside the character's name on any of its messages speaks
  that message again, even with **Speak replies** off.

To give a character a voice, choose a recording under **Voice** when you
create or edit the character: one person speaking clearly, for more than 5
seconds. The engine
clones the voice from it. The browser reads the recording (WAV, MP3, M4A and
whatever else it can play), keeps the first 30 seconds as a mono WAV file,
and the app stores that in its data folder. A recording of 5 seconds or less
is refused. For a character being edited, the clip is saved as soon as it is
chosen; choosing another replaces it, **Remove voice clip** goes back to the
built-in voice, and **Preview voice** speaks a sample line. For a new
character, the clip is saved with the character, and the cloned voice can be
previewed once it is saved. Opening a chat has the engine prepare
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
- **Speech and narration are told apart by rule of thumb.** A reply that
  changes how it is written part-way (narration first, then quotation marks,
  after a message that had none) can have a sentence of narration spoken,
  because what has been sent to be spoken cannot be taken back. Dialogue in
  single quotation marks is not recognised.
- **A sentence already sent to the engine is always finished.** Stopping
  speech stops the sound at once, but the engine completes the clip it is
  making.
- **Token counts are estimates with OpenAI.** The conversation budget
  counts four characters as a token, which suits English prose and
  undercounts some other languages. KoboldCpp counts tokens itself; only a
  text it could not count is estimated, at a cautious three characters a
  token, and then a tenth of the context is kept free as well. Text in some
  scripts (Chinese, Japanese) or full of emoji can still be more than that.

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
7. Tick **Speak replies** again. In **Settings > Speech**, set **What is spoken** to
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
9. Choose **Characters**, then **New character**. Name it `Tomas`, choose your
   recording under **Voice clip** and choose **Save character**. Choose
   **Edit** on Tomas, then **Preview voice**. Expect the sample line in the
   cloned voice.

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

## Manual check: illustrating a message

Needs the real engine, so a GPU, and an OpenAI API key.

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Wait until the page shows **Engine ready**.
3. Choose **New chat**, then **Start chat**. Choose **Illustrate** under
   Mara's opening message. Expect a note that a reference picture is needed,
   with a link. (Skip to step 4 if Mara already has a picture.)
4. Follow the link, choose **Generate picture**, wait for the portrait, and
   go back to the chat in the sidebar.
5. Choose **Illustrate** under the opening message. Expect **Describing the
   scene…**, then **Painting the location…**, then **Painting the scene…**,
   and within about 20 seconds a wide picture under the message: Mara, as in
   her portrait, in a lighthouse kitchen with a stove and a stair.
6. While it is painting, send `Is it always this rough out here?` with
   **Speak replies** on. Expect the reply to be spoken as promptly as usual.
7. Choose **Illustrate** under the reply. Expect no **Painting the
   location…** step this time, and the same kitchen in the new picture.
   The header still says **At The lighthouse kitchen**.
8. Choose a picture. Expect it at full size over the page; **Close** or
   Escape ends that.
9. Reload the page. Expect both pictures still there.
10. In **Settings > Images**, set **Scene model** to `no-such-model` and save.
    Choose **Illustrate** again. Expect an error from OpenAI under the
    message with **Try again**. Put the scene model back, choose **Try
    again**, and expect a picture.

## Manual check: scenes follow the story

Needs the real engine, an OpenAI API key, and Mara Quill's reference
picture (see the previous check).

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Choose **New chat**, then **Start chat**. Expect the header to say
   **At The lighthouse kitchen**.
3. Send `Show me the lamp. Let's go up to the lamp room now.` and wait for
   a reply in which Mara takes you up the tower.
4. Choose **Illustrate** under the reply. Expect **Painting the location…**
   and then a picture of Mara in a glass lamp room at the top of a tower.
   The header now names the lamp room (the scene call chooses the exact
   name).
5. Open **Locations**. Expect two places, each with its picture, the second
   marked **(here now)**.
6. Send `Let's go back down to the kitchen and warm up.`, wait for the reply,
   and choose **Illustrate** under it. Expect no **Painting the location…**
   step, the header back at **At The lighthouse kitchen**, and the kitchen of
   the first pictures in the new one.
7. Under the kitchen in **Locations**, choose **Generate another**. Expect a
   different picture of the kitchen in its place.
8. Reload the page. Expect the same places and pictures.

## Manual check: automatic illustration

Needs the real engine, an OpenAI API key, and Mara Quill's reference
picture (see the checks above).

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. In **Settings > Images**, expect **Illustrate replies by themselves** to be **Key
   moments** and **Cooldown** to be 3.
3. Choose **New chat**, then **Start chat**. Send
   `Show me the lamp. Let's climb up to the lamp room.` Expect, a few
   seconds after the reply, a picture under it without choosing
   **Illustrate**, and the header to name the lamp room.
4. Send two or three ordinary messages (`It is very bright.`,
   `How long have you kept this light?`). Expect most of them to get no
   picture: at most one every three replies, unless the story moves.
5. In **Settings > Images**, choose **Off** and save, then reload the page. Expect
   **Off** still chosen. Back in the chat, send
   `Let's go back down to the kitchen.` Expect no picture, and the header
   to say **At The lighthouse kitchen** again. Choose **Illustrate** under the reply: expect a picture.
6. Choose **Every reply** and save. Send two messages. Expect a picture
   under each reply.
7. Choose **Key moments** again. In **Settings > Images**, set **Scene model** to
   `no-such-model` and save. Send a message. Expect the reply as usual, no
   picture, and in the terminal running the app a line saying the scene
   call after a reply failed. Put the scene model back.

## Manual check: replies from KoboldCpp

Needs KoboldCpp running on another PC on the network with a model loaded, for
example `koboldcpp.exe --model <file>.gguf --host 0.0.0.0 --port 5001
--contextsize 8192`, and its IPv4 address (`ipconfig` on that PC).

1. Start the app: `cd C:\docs\git\chatThree; pwsh ./start.ps1`
2. Open **Settings > Connection**, set **Text backend** to **KoboldCpp** and
   expect the OpenAI key and model fields to go. Enter the server address,
   such as `http://192.168.1.50:5001`, and choose **Test connection**. Expect
   **Connected.** with the model's name, such as
   `koboldcpp/gemma-4-31B-it-Q4_K_S`, and its context length, and the name in
   **Loaded model**. Choose **Save**.
3. Choose **New chat**, then **Start chat**, and send
   `Is it always this rough out here?`. Expect a reply from the local model,
   streamed and spoken as it arrives (the first token may take several
   seconds while KoboldCpp reads the prompt). With a thinking model, such as
   a Qwen3, expect **Thinking…** first, then the reply with no thoughts in
   it, shown, spoken and saved.
4. Ask for something long, such as `Tell me the whole history of this
   lighthouse.`, and choose **Stop** part-way through the reply. Expect the
   reply to stop and what was written to stay, and KoboldCpp's console on the
   other PC to stop generating at once (its output stops; the next request
   starts without waiting). Then choose
   **Regenerate**, and **Delete** on the last message: both work as with
   OpenAI.
5. Stop KoboldCpp, and send a message. Expect an error that says it could not
   reach KoboldCpp at the address you entered, not OpenAI.
6. Set **Text backend** back to **OpenAI** and save. Expect the next reply
   from OpenAI, without restarting the app.

## Check it

```powershell
cd C:\docs\git\chatThree; pwsh ./verify.ps1
```

One command runs every check for the engine and the app: formatting, lint,
type checking, unit tests, end-to-end tests, dependency audit and build. It
also needs [uv](https://docs.astral.sh/uv/), and downloads a headless browser
for the end-to-end tests the first time. It needs no GPU, model files or API
keys. CI runs the same script.
