#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <audio-file>" >&2
  exit 2
fi

INPUT="$1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_MODEL="$SCRIPT_DIR/whisper.cpp/models/ggml-large-v3-turbo.bin"
DEFAULT_BIN="$SCRIPT_DIR/whisper.cpp/build-cuda/bin/whisper-cli"
FALLBACK_BIN="$SCRIPT_DIR/whisper.cpp/build/bin/whisper-cli"

MODEL_PATH="${WHISPER_MODEL:-$DEFAULT_MODEL}"
WHISPER_BIN="${WHISPER_BIN:-$DEFAULT_BIN}"
if [[ ! -x "$WHISPER_BIN" && -x "$FALLBACK_BIN" ]]; then
  WHISPER_BIN="$FALLBACK_BIN"
fi
WHISPER_LANG="${WHISPER_LANG:-auto}"
WHISPER_THREADS="${WHISPER_THREADS:-$(nproc)}"
WHISPER_PROCESSORS="${WHISPER_PROCESSORS:-1}"
WHISPER_NO_GPU="${WHISPER_NO_GPU:-0}"

if [[ ! -f "$MODEL_PATH" ]]; then
  echo "whisper model not found: $MODEL_PATH" >&2
  echo "Set WHISPER_MODEL or download model to $DEFAULT_MODEL" >&2
  exit 2
fi

if [[ ! -x "$WHISPER_BIN" ]]; then
  if ! command -v "$WHISPER_BIN" >/dev/null 2>&1; then
    echo "whisper binary not found/executable: $WHISPER_BIN" >&2
    echo "Set WHISPER_BIN or build whisper.cpp (expected: $DEFAULT_BIN)" >&2
    exit 2
  fi
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required but not found in PATH" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

WAV_INPUT="$TMP_DIR/input.wav"
OUT_PREFIX="$TMP_DIR/transcript"

# Normalize any Telegram voice/audio format to WAV (16k mono) for robust whisper input.
ffmpeg -nostdin -hide_banner -loglevel error -y \
  -i "$INPUT" \
  -ac 1 -ar 16000 -c:a pcm_s16le \
  "$WAV_INPUT"

WHISPER_ARGS=(
  -m "$MODEL_PATH"
  -f "$WAV_INPUT"
  -l "$WHISPER_LANG"
  -t "$WHISPER_THREADS"
  -p "$WHISPER_PROCESSORS"
  -np
  -otxt
  -of "$OUT_PREFIX"
)

if [[ "$WHISPER_NO_GPU" == "1" ]]; then
  WHISPER_ARGS+=( -ng )
fi

"$WHISPER_BIN" "${WHISPER_ARGS[@]}" >/dev/null

TXT_FILE="${OUT_PREFIX}.txt"
if [[ ! -f "$TXT_FILE" ]]; then
  echo "whisper did not produce transcript file" >&2
  exit 1
fi

# Print transcript to stdout (daemon expects this).
tr '\n' ' ' < "$TXT_FILE" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
