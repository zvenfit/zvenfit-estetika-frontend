#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTION_DIR="${ROOT_DIR}/functions/telegram-lead"
OUTPUT_DIR="${1:-}"

if [[ -z "${OUTPUT_DIR}" ]]; then
  echo 'package-telegram-lead: output directory is required' >&2
  exit 2
fi

if [[ ! -f "${FUNCTION_DIR}/build/index.js" ]]; then
  echo 'package-telegram-lead: compiled build/index.js is missing; run the function build first' >&2
  exit 1
fi

if [[ -d "${OUTPUT_DIR}" && -n "$(find "${OUTPUT_DIR}" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo 'package-telegram-lead: output directory must be empty' >&2
  exit 1
fi

mkdir -p "${OUTPUT_DIR}"
cp -R "${FUNCTION_DIR}/build/." "${OUTPUT_DIR}/"
cp "${FUNCTION_DIR}/package.json" "${FUNCTION_DIR}/package-lock.json" "${OUTPUT_DIR}/"
npm pkg delete devDependencies --prefix "${OUTPUT_DIR}"

echo "package-telegram-lead: prepared ${OUTPUT_DIR}"
