#!/bin/sh
# Download the pinned third-party libraries used by the content script.
# Turndown (MIT License) and Readability (Apache License 2.0) are fetched
# from the jsDelivr CDN so this repository does not redistribute them.
set -e
cd "$(dirname "$0")"
curl -fsSL -o turndown.js "https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js"
curl -fsSL -o Readability.js "https://cdn.jsdelivr.net/npm/@mozilla/readability@0.6.0/Readability.js"
echo "Libraries downloaded to lib/"
