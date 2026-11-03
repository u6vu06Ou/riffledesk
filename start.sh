#!/bin/sh
# riffledesk POSIX launcher.
cd "$(dirname "$0")" || exit 1
exec node bin/riffledesk.js "$@"
