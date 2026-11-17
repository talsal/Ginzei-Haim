#!/bin/bash
cd "$(dirname "$0")"
node ginzei-youtube.mjs --keep-going "$@"
echo
read -p "לחצו Enter לסגירה"
