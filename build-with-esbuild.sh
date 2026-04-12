#!/bin/bash
# Download esbuild directly and run it
curl -L -o esbuild.tgz https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.19.11.tgz 2>/dev/null
tar xf esbuild.tgz
./package/bin/esbuild "$@"
