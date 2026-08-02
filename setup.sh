#!/usr/bin/env bash
# Set up the analysis pipeline: Python deps + a Stockfish binary.
set -euo pipefail

cd "$(dirname "$0")"

SF_TAG="${SF_TAG:-sf_18}"
ENGINE_DIR="engine"
ENGINE_BIN="$ENGINE_DIR/stockfish-bin"

echo "==> Python environment"
python3 -m venv .venv
.venv/bin/pip install --quiet --upgrade pip setuptools wheel
.venv/bin/pip install --quiet -r requirements.txt
.venv/bin/python -c "import chess; print('    python-chess', chess.__version__)"

if [ -x "$ENGINE_BIN" ]; then
  echo "==> Stockfish already present"
else
  echo "==> Downloading Stockfish $SF_TAG"
  mkdir -p "$ENGINE_DIR"

  # Pick the most capable build this CPU can actually run.
  FLAGS=$(grep -m1 '^flags' /proc/cpuinfo || echo "")
  if [[ "$FLAGS" == *avx512f* ]]; then
    VARIANT="avx512"
  elif [[ "$FLAGS" == *bmi2* ]]; then
    VARIANT="bmi2"
  elif [[ "$FLAGS" == *avx2* ]]; then
    VARIANT="avx2"
  else
    VARIANT="sse41-popcnt"
  fi
  echo "    variant: $VARIANT"

  URL="https://github.com/official-stockfish/Stockfish/releases/download/$SF_TAG/stockfish-ubuntu-x86-64-$VARIANT.tar"
  curl -sSL --retry 3 --max-time 600 -o "$ENGINE_DIR/sf.tar" "$URL"
  tar xf "$ENGINE_DIR/sf.tar" -C "$ENGINE_DIR"
  mv "$ENGINE_DIR/stockfish/stockfish-ubuntu-x86-64-$VARIANT" "$ENGINE_BIN"
  rm -rf "$ENGINE_DIR/stockfish" "$ENGINE_DIR/sf.tar"
  chmod +x "$ENGINE_BIN"
fi

echo "==> Verifying engine"
printf 'uci\nisready\nquit\n' | "$ENGINE_BIN" | grep -E '^id name|^uciok|^readyok' | sed 's/^/    /'

echo "==> Ready."
