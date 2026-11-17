#!/bin/bash
cd "$(dirname "$0")"
node ginzei-youtube.mjs --fix-only "$@"
echo
read -p "לחצו Enter לסגירה"
