#!/bin/zsh
cd "${0:A:h}"
node tools/local-service.mjs stop
read -k 1
