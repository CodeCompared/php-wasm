PHP 8.5.8 for the browser, with working Fibers
==============================================

A build of WordPress Playground's php-wasm — `@php-wasm/web-8-5` 3.1.50, PHP
8.5.8, the asyncify web variant — with four defects fixed. It is a drop-in
replacement for the published package's runtime files, and pairs with the
unmodified `@php-wasm/universal@3.1.50` from npm.

|                                                      | Published 3.1.50            | This build                          |
| ---------------------------------------------------- | --------------------------- | ----------------------------------- |
| `new Fiber(...)`, `suspend()`, `resume()`, `throw()` | aborts the runtime          | works                               |
| the abort message when a symbol is missing           | `missing function: ${name}` | names the function                  |
| `popen()`                                            | kills the browser tab       | returns `false` with a warning      |
| `file_get_contents('https://…')`                     | traps on `unreachable`      | returns `false`                     |
| `curl_exec()`                                        | traps on `unreachable`      | returns `false`, `curl_error()` set |
| `fsockopen()`                                        | traps on `unreachable`      | returns a handle whose reads fail   |

Cost: **5,252 bytes**, against the published binary's 21,019,221. The wire
transfer is about 7 MB, because CDNs serve WebAssembly compressed.


The two worth reading about
---------------------------

**Fibers.** `--disable-fiber-asm` makes PHP switch fiber stacks through POSIX
`getcontext` / `makecontext` / `swapcontext`, and Emscripten links all three to
a stub that calls `abort()`. This build adds an implementation of those three
on top of Emscripten's own fiber API, and names the fiber call path in
`ASYNCIFY_ONLY`, since a fiber suspends by unwinding the whole WebAssembly
stack.

**The network traps were a Chrome regression, not a limitation.** The build
asked the *browser* whether it supported JSPI and treated the answer as saying
how the *binary* had been built. That held until Chrome shipped JSPI; from
then on an asyncify build running in Chrome took the branch written for JSPI
builds and trapped. The same binary in Firefox or Safari has always failed
gracefully. It is now a build-time decision.

`docs/findings.md` in this repository has the full account, including two
hypotheses about the traps that turned out to be wrong.


Assets
------

| File            | Bytes                    |
| --------------- | ------------------------ |
| `php_8_5.js`    | 208,103                  |
| `php_8_5.wasm`  | 21,024,473               |
| `VENDORED.json` | provenance and checksums |

`VENDORED.json` records the commit and clean/dirty state of both repositories
that produced these, and each file's sha256. Verify before use.

**`php_8_5.wasm` must be served at `8_5_8/php_8_5.wasm` relative to
`php_8_5.js`**, because the loader resolves it from its own URL.

One change was made to the loader that is not in the compiler output: its
opening line imports the `.wasm` file the way a bundler expects, which no
browser can resolve. Upstream publishes to npm through Vite, which rewrites
it; a locally built loader has never been through that. It is rewritten here
to the URL form a bundler emits, and `VENDORED.json` records the exact
substitution.


Not included
------------

`intl` — it needs no build change, ships in the published npm package already,
and loads through `resolvePHPExtension`. But the npm package ships no ICU
data, so the extension loads and every constructor still fails; the data file
is 30.78 MB raw and 11.55 MB gzipped, larger than PHP itself. See
`docs/findings.md` §6.


Known limitations
-----------------

- `fsockopen()` returns a handle rather than `false`. The failure surfaces at
  the first read instead of at `connect()`, which is what Firefox and Safari
  have always done here. Recoverable, which an abort is not.
- `gmp` and `sodium` are still absent.
- `exec`, `shell_exec`, `system`, `passthru`, `proc_open` and `popen` are
  still declared, so `function_exists()` returns true for all six. They no
  longer end the run.


Upstream
--------

These changes are not upstream yet. They are prepared as three commits against
`WordPress/wordpress-playground` in `patches/`, with a description in
`docs/upstream-pull-request.md`.
