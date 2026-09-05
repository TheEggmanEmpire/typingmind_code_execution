## Code Runner (multi-language)

Runs code in 12 languages and returns the output to the AI. No API key. No server.

- **python** - Pyodide (WASM, in-browser). numpy/pandas auto-load from imports; other PyPI packages via `packages`.
- **javascript** - runs in the plugin sandbox.
- **sql** - SQLite via sql.js (WASM, in-browser).
- **c, c++, rust, go, ruby, java, csharp, haskell, lua** - Compiler Explorer (godbolt.org) public API.

First Python call takes ~5-15 s while the runtime downloads. Java: do not declare the class `public`.

Toolchains (Compiler Explorer): gcc 14.2, rustc 1.82, Go 1.26, Ruby 4.0, JDK 25, .NET 9 (Mono), GHC 9.8, Lua 5.5.

Example: *Use run_code to compute the first 20 primes in Rust.*
