#!/bin/bash
# stands in for an editor: records how it was called
echo "$@" > "$(dirname "$0")/editor-call.txt"
