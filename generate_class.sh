#!/usr/bin/env bash
# generate_class.sh — generate a SpinOff class.txt from a folder of audio files
#
# Usage:  ./generate_class.sh <folder> [output_file]
# Output: class.txt (or specified file) — edit %FTP, resistance, type, and cues.
#
# Requires ffprobe (part of ffmpeg) for tag reading.
# Install: brew install ffmpeg  /  apt install ffmpeg

set -uo pipefail

FOLDER="${1:-}"
OUTPUT="${2:-class.txt}"
AUDIO_EXTS="mp3|m4a|aac|flac|wav|ogg|opus|webm"

# ── Validation ────────────────────────────────────────────────────────────────
if [[ -z "$FOLDER" || ! -d "$FOLDER" ]]; then
  echo "Usage: $0 <folder> [output_file]"
  echo "  folder      directory containing audio files"
  echo "  output_file path for generated class.txt (default: class.txt)"
  exit 1
fi

HAS_FFPROBE=0
if command -v ffprobe &>/dev/null; then
  HAS_FFPROBE=1
else
  echo "Warning: ffprobe not found — titles/artists/BPM will be inferred from filenames only."
  echo "         Install ffmpeg to read audio tags: brew install ffmpeg / apt install ffmpeg"
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

# Read a single tag from an audio file via ffprobe; empty string if missing
tag() {
  local file="$1" key="$2"
  ffprobe -v quiet \
    -show_entries "format_tags=$key" \
    -of default=noprint_wrappers=1:nokey=1 \
    "$file" 2>/dev/null | head -1 | tr -d '\r\n'
}

# Round a float to nearest integer (handles "128.00" → "128")
round() {
  printf "%.0f" "${1:-0}" 2>/dev/null || echo "${1%%.*}"
}

# Convert "01 - Some Song_name" → "Some Song Name"
prettify() {
  echo "$1" \
    | sed 's/\.[^.]*$//' \
    | sed 's/^[0-9][0-9]*[[:space:]._-]*//' \
    | sed 's/[_-]/ /g' \
    | sed 's/[[:space:]]\{2,\}/ /g' \
    | awk '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) tolower(substr($i,2)); print}'
}

# ── Main ──────────────────────────────────────────────────────────────────────

# Collect audio files, sorted
mapfile -t FILES < <(
  find "$FOLDER" -maxdepth 1 -type f \
  | grep -iE "\.($AUDIO_EXTS)$" \
  | sort
)

if [[ ${#FILES[@]} -eq 0 ]]; then
  echo "No audio files found in: $FOLDER"
  exit 1
fi

echo "Found ${#FILES[@]} audio file(s) in $FOLDER"

{
  echo "# SpinOff class — generated $(date '+%Y-%m-%d') from: $(basename "$FOLDER")"
  echo "# Edit: Type, %FTP, Resistance, and cues. Titles/artists/BPM read from tags."
  echo "# %FTP zones: <55 white  55-75 grey  75-90 blue  90-105 green  105-120 yellow  120+ red"
  echo "# Cues: M:SS text   use **bold** for emphasis"
  echo ""

  IDX=0
  for FILE in "${FILES[@]}"; do
    IDX=$((IDX + 1))
    FILENAME="$(basename "$FILE")"

    # ── Read tags ─────────────────────────────────────────────────────────────
    TITLE="" ARTIST="" BPM=""

    if [[ $HAS_FFPROBE -eq 1 ]]; then
      TITLE="$(tag "$FILE" title)"
      ARTIST="$(tag "$FILE" artist)"
      BPM="$(tag "$FILE" bpm)"
      # Some taggers use TBPM
      [[ -z "$BPM" ]] && BPM="$(tag "$FILE" TBPM)"
      # Round BPM if it's a decimal
      if [[ -n "$BPM" ]]; then
        BPM="$(round "$BPM")"
      fi
    fi

    # ── Fallbacks from filename ────────────────────────────────────────────────
    [[ -z "$TITLE"  ]] && TITLE="$(prettify "$FILENAME")"
    [[ -z "$ARTIST" ]] && ARTIST="Unknown"
    [[ -z "$BPM"   ]] && BPM="???"

    # ── Default type based on position ───────────────────────────────────────
    TOTAL=${#FILES[@]}
    if   [[ $IDX -eq 1 ]];          then TYPE="Warm-up"
    elif [[ $IDX -eq $TOTAL ]];     then TYPE="Cool-down"
    else                                 TYPE="Tempo"
    fi

    echo "## $TITLE | $ARTIST | $TYPE | $BPM BPM | 80 | 5 | $FILENAME"
    echo ""
    echo "0:00 "
    echo ""
  done
} > "$OUTPUT"

echo "Generated: $OUTPUT"
echo ""
echo "Next steps:"
echo "  1. Open $OUTPUT and set %FTP and Resistance for each track"
echo "  2. Change Type where needed (Warm-up / Endurance / Tempo / Climb / Sprint / Cool-down)"
echo "  3. Add cue lines below each track header (format: M:SS text)"
echo "  4. Upload the folder + class.txt to Dropbox/Apps/SpinOffApp/<class-name>/"
