#!/bin/zsh
cd "${0:A:h}"
if ! command -v node >/dev/null; then
  print '请先安装 Node.js 20 或更新版本。'
  read -k 1
  exit 1
fi
if [[ -z "$DEEPSEEK_ENV_FILE" && -f .env ]]; then
  export DEEPSEEK_ENV_FILE=.env
fi
node tools/local-service.mjs start
read -k 1
