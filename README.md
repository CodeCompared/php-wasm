php-wasm — Fibers, and the other gaps
=====================================

Work on the in-browser PHP build that WordPress Playground publishes as
`@php-wasm/web-8-5`, which [CodeCompared](https://codecompared.to) offers as
one of three PHP runtimes — the only one that works offline, the only one that
does not send the reader's code to a third party, and the newest PHP by two
minor versions.

Upstream is <https://github.com/WordPress/wordpress-playground>. Nothing here
is a fork of it. `src/` holds work meant to go back, `patches/` holds it as
patch files, and `upstream/` is a plain checkout that `scripts/` drives.

**`docs/findings.md` is the substance of this project**: what each defect was,
what caused it, what fixed it, and what was ruled out along the way.


Where it stands
---------------

|                                                             | Before                       | After                               |
| ----------------------------------------------------------- | ---------------------------- | ----------------------------------- |
| `new Fiber(...)`, `Fiber::suspend()`, `resume()`, `throw()` | aborts the runtime           | works                               |
| the abort message when a symbol is missing                  | `missing function: ${name}`  | names the function                  |
| `popen()`                                                   | kills the browser tab        | returns `false` with a warning      |
| `file_get_contents('https://…')`                            | traps on `unreachable`       | returns `false`                     |
| `curl_exec()`                                               | traps on `unreachable`       | returns `false`, `curl_error()` set |
| `fsockopen()`                                               | traps on `unreachable`       | returns a handle whose reads fail   |
| `intl`                                                      | thought to need compiling in | already shipped; loads today        |

13 of 13 probes pass against a build from this tree; 4 of 13 pass against the
published package. The whole change costs **5,252 bytes** of WebAssembly on a
21,019,221-byte binary — 0.025%.

Still open: `fsockopen()` returns a handle rather than `false`; `gmp` and
`sodium` are untouched; the process functions are still declared even though
they no longer kill the tab; and ICU's data file wants trimming before `intl`
is affordable. `docs/findings.md` has the detail on each.

**Nothing has been pushed and no pull request has been opened.**
`docs/upstream-pull-request.md` is the description to send if you want one,
with the commands.


What is here
------------

| Path                               | What it is                                                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ucontext-emscripten.c`        | A POSIX `ucontext(3)` implementation for WebAssembly, built on Emscripten's fiber API. This is what makes PHP Fibers run.                 |
| `test/prototype/fiber-prototype.c` | The seven things PHP does to a `ucontext_t`, reproduced outside PHP so a mistake shows up in seconds instead of after an hour-long build. |
| `test/probe/probes.mjs`            | Thirteen PHP snippets and what each one is supposed to prove.                                                                             |
| `test/probe/run-probes.mjs`        | Runs them in headless Chromium, against either the published package or a local build.                                                    |
| `scripts/check-prototype.sh`       | Builds the prototype under four Asyncify configurations and checks each behaves as expected.                                              |
| `scripts/build-php.sh`             | Builds php-wasm from `upstream/` with these changes applied.                                                                              |
| `scripts/trace-trap.mjs`           | Prints the WebAssembly stack of whatever a snippet trapped on, with names.                                                                |
| `scripts/asyncify-advise-list.mjs` | Turns an `ASYNCIFY_ADVISE=1` build log into an `ASYNCIFY_ONLY` list.                                                                      |
| `patches/`                         | The three upstream commits as patch files.                                                                                                |
| `upstream/`                        | A checkout of WordPress Playground. Not committed — see below.                                                                            |


Getting set up
--------------

```
git clone --depth 1 https://github.com/WordPress/wordpress-playground.git upstream
npm install
npx playwright install chromium
```

`scripts/check-prototype.sh` additionally needs `emcc` on the path (Homebrew's
`emscripten` will do), and `scripts/build-php.sh` needs Docker running.


Running things
--------------

```
npm run check:prototype      # the ucontext shim, four Asyncify configurations
npm run probe:published      # the "before" picture, straight from the CDN
scripts/build-php.sh         # build PHP 8.5.8 for the web, asyncify
npm run probe:local          # the "after" picture
```

`npm run probe:published` is **expected to exit non-zero** — that is the bug
being reproduced, and the output says so probe by probe.

Two things worth knowing before you run anything:

- **One runtime per page.** Creating several PHP runtimes in one browser page
  exhausts memory and the page dies in a way that looks exactly like a bug in
  the probe. The harness gives every probe its own page for that reason.
- **The first build takes about an hour**, mostly compiling PHP. Later builds
  reuse Docker's layer cache: a change to `ucontext-emscripten.c` or to the
  Asyncify only-list re-runs only the final link, because both come after the
  `emmake make` layer in the Dockerfile.

When a trap needs diagnosing, build with `WITH_FUNCTION_NAMES=yes` first — a
shipping build strips the WebAssembly name section, so the stack comes back as
bare function indices — then:

```
node scripts/trace-trap.mjs "<?php @fsockopen('example.com', 80);"
```


Why PHP Fibers aborted, in one paragraph
----------------------------------------

PHP switches stacks for a `Fiber` using assembly borrowed from Boost.Context.
There is no assembly in WebAssembly, so the php-wasm build passes
`./configure --disable-fiber-asm`, which makes PHP fall back to the POSIX
`getcontext` / `makecontext` / `swapcontext` trio instead. Emscripten has no
implementation of those, so it links them to a stub that calls `abort()`. The
first `Fiber::suspend()` reached the stub and the runtime died.

Emscripten does have stack switching of its own, which its documentation
describes as "similar to, but distinct from, POSIX ucontext".
`src/ucontext-emscripten.c` supplies the missing distinctness.

Two details make this smaller than it sounds. PHP calls
`makecontext(handle, fn, 0)` with **zero** arguments, so none of the variadic
marshalling that makes a general `makecontext` awkward is needed. And PHP
touches only `uc_stack` and `uc_link`, which leaves the register-save space
that WebAssembly has no use for free to hold the Emscripten fiber — no side
table, no allocation, and so nothing whose lifetime has to be tracked without
a `destroycontext` to hook.
