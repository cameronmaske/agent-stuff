# Telegram Bridge (topic-per-session mode)

Bridge a live interactive pi session to Telegram. Each pi session can create its own **forum topic** in a Telegram supergroup.

## Install

```bash
cd ~/.pi/agent/extensions/telegram
npm install
```

Then restart pi or run `/reload` in an existing session.

## One-time setup

1. Create bot token via `@BotFather`.
2. In pi, run:

```text
/telegram pair
```

3. In Telegram DM with your bot, send `/pin <code>`.
4. Add bot to your **supergroup with Topics enabled**.
5. Promote bot to admin with **Manage Topics** permission.
6. In that supergroup, send:

```text
/setforum
```

## Per-session flow

In any pi session:

```text
/telegram
```

This creates and binds a new forum topic for that session.
By default, topic title is auto-derived from recent session work (short phrase).
The starter message in the topic includes the current pi model and thinking level.

Optional custom title:

```text
/telegram topic my-debug-session
```

## Dynamic topic icons

When a topic is bound, the daemon updates the **forum topic icon** automatically:

- `thinking` while pi is actively working
- `green` when context usage is below 60%
- `yellow` at 60-80%
- `red` at 80%+

Default icon mapping is:

- thinking: `🧠`
- green: `✅`
- yellow: `⚡️`
- red: `‼️`

You can override by emoji (`topicIconEmojis`) or direct Telegram custom emoji IDs (`topicIconCustomEmojiIds`) in config.

## pi commands

```text
/telegram                 # create+bind topic for this session
/telegram topic [title]   # create+bind topic with optional title
/telegram new             # start fresh pi session and keep current topic binding
/telegram pair                  # pair owner account via PIN
/telegram status                # show bridge status
/telegram voice-model [model]   # get/set whisper model
/telegram voice-install [model] # guided whisper.cpp install/setup
/telegram restart               # restart daemon and reconnect
/telegram stop                  # disconnect this window from daemon
/telegram unpair                # clear owner pairing
```

## Telegram commands

- `/help` – show help
- `/setforum` – set current supergroup as forum home
- `/forumstatus` – show owner/forum binding status
- `/windows` – list connected windows + topic bindings
- `/project new <project_name>` – create a Telegram-only project topic (phase 1)
- `/new` – start a fresh pi session for the current topic (window-bound or project topic)
- `/steer <message>` – interrupt active topic window/session
- `/esc` – abort active topic window/session
- `/reload` – reconnect bridge for active topic window (resync connection/binding)
- `/unpair` – clear owner pairing
- plain text inside a bound topic – sent as follow-up to that session
- voice memo inside a bound topic – reacted with ⏳ while processing, then transcript is posted (🗣️) and sent as follow-up

## Project topics (phase 1)

From your forum supergroup (typically general topic):

```text
/project new life-admin
```

This creates a dedicated Telegram topic and runs a short setup wizard in that topic:

1. project root path (`cwd`)
2. storage directory for notes/todos/research

After setup, the daemon starts a detached `pi --mode rpc` worker for that topic and resets to a fresh session (`/new` equivalent) before chat begins.

Current phase-1 limitations:

- `/project join` is intentionally deferred
- voice memo routing for detached project topics is not implemented yet

## Config path

- `~/.pi/agent/extensions/telegram/config.json`

```json
{
  "botToken": "123:abc...",
  "ownerUserId": 123456789,
  "ownerDmChatId": 123456789,
  "forumChatId": -1001234567890,
  "voiceTranscribeCommand": "/path/to/transcribe-voice.sh {input}",
  "voiceTranscribeTimeoutSec": 180,
  "whisperModelPath": "large-v3-turbo",
  "topicIconEnabled": true,
  "topicIconEmojis": {
    "thinking": "🧠",
    "green": "✅",
    "yellow": "⚡️",
    "red": "‼️"
  },
  "topicIconCustomEmojiIds": {
    "thinking": "5237889595894414384"
  }
}
```

## Runtime socket

- `~/.pi/agent/run/telegram.sock`
- daemon singleton lock: `~/.pi/agent/run/telegram-daemon.lock`

The daemon now uses a lock file to prevent multiple instances from running at the same time.

Detached project topic metadata is persisted in:

- `~/.pi/agent/extensions/telegram/project-profiles.json`
- `~/.pi/agent/extensions/telegram/project-topics.json`

## Daemon logs

- `~/.pi/agent/extensions/telegram/daemon.log`
- rotated backup: `~/.pi/agent/extensions/telegram/daemon.log.1`

Tail live logs:

```bash
tail -f ~/.pi/agent/extensions/telegram/daemon.log
```

## Voice memo transcription setup

Voice memo support requires a local transcription command.

- Configure `voiceTranscribeCommand` in `config.json`
- Use `{input}` placeholder for the downloaded voice file path
- The command **must print transcript text to stdout**

Built-in whisper.cpp wrapper included:

```bash
# one-time
chmod +x ~/.pi/agent/extensions/telegram/transcribe-voice-whispercpp.sh
```

Defaults used by the wrapper:

- binary: `~/.pi/agent/extensions/telegram/whisper.cpp/build-cuda/bin/whisper-cli` (falls back to CPU build)
- model: `~/.pi/agent/extensions/telegram/whisper.cpp/models/ggml-large-v3-turbo.bin`

Then in config:

```json
{
  "voiceTranscribeCommand": "~/.pi/agent/extensions/telegram/transcribe-voice-whispercpp.sh {input}",
  "voiceTranscribeTimeoutSec": 600,
  "whisperModelPath": "large-v3-turbo"
}
```

Or set it from pi:

```text
/telegram voice-model large-v3-turbo
/telegram voice-model /abs/path/to/model.bin
/telegram voice-install [model]
```

If a voice memo arrives before whisper is set up, pi will prompt you to run the guided install flow.
The guided flow clones whisper.cpp if needed, tries a CUDA build first (then falls back to CPU), downloads the model, and sets `voiceTranscribeCommand` to the built-in wrapper.

Optional overrides via env vars:

- `WHISPER_MODEL` (custom model path)
- `WHISPER_BIN` (custom whisper binary)
- `WHISPER_LANG` (default: `auto`)
- `WHISPER_THREADS` (default: all logical CPU cores)
- `WHISPER_PROCESSORS` (default: `1`)
- `WHISPER_NO_GPU=1` (force CPU mode)

You can also provide your own custom command/script.

## Notes

- Incoming Telegram messages are injected with `sendUserMessage`, so they appear in terminal session history.
- Assistant output mirrored to Telegram is the assistant text at `turn_end`.
- Topic bindings are persisted per session and restored across `/reload`.
- `/telegram status` shows the current computed icon state + context usage percent.
- Topic icon updates are deduplicated (same target state is not resent), and state transitions are applied immediately.
- Once owner + forum are configured, the daemon stays alive without connected pi windows so Telegram-only project topics can be started from forum/general.
- Stale-topic cleanup can be disabled via `"staleTopicCleanupEnabled": false` in config while debugging restart/binding behavior.
- After topic creation, the daemon attempts `unpinAllForumTopicMessages` to avoid pinned starter messages (requires sufficient bot permissions).
- If an old config exists at `~/.pi/agent/telegram/config.json`, it is auto-migrated.
- If bot does not receive plain topic text, disable bot privacy mode in BotFather (`/setprivacy` -> `Disable`).
