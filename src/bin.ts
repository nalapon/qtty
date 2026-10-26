// Entry point of the compiled binary (`bun run build`). GPUIX's native addon lives in
// its own npm package, which `bun build --compile` does not pick up through the
// loader's dynamic require; embedding the file and pointing the napi-rs loader at
// it (its documented override) makes the binary carry the renderer.

import addon from "@gpuix/native-darwin-arm64/gpuix-native.darwin-arm64.node" with { type: "file" }

process.env.NAPI_RS_NATIVE_LIBRARY_PATH = addon
await import("./main.ts")
