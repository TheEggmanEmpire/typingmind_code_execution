#!/bin/sh
set -eu
cd "$(dirname "$0")"
gcc -O2 -Wall -Wextra -o crbox crbox.c
