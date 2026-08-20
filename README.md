php-wasm — Fibers, and the other gaps
=====================================

Work on the in-browser PHP build that WordPress Playground publishes as
`@php-wasm/web-8-5`, aimed at four things it cannot currently do:

1. **Run a PHP `Fiber`.** Starting one kills the runtime today, and every
   later run in the same instance fails too.
2. **Fail recoverably.** A network call or `popen()` currently traps, which
   PHP code cannot catch; `popen()` takes the whole browser tab with it.
3. **Say what went wrong.** The abort message that fires on a missing
   function has never named the function, because of a quoting slip.
4. **Offer `intl`, `gmp` and `sodium`,** which the web build omits.

Upstream is <https://github.com/WordPress/wordpress-playground>. Nothing here
is a fork of it; the sources in `src/` are meant to be contributed back, and
`upstream/` is a plain checkout that `scripts/` drives.


What is here
------------

| Path                               | What it is                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ucontext-emscripten.c`        | A POSIX `ucontext(3)` implementation for WebAssembly, built on Emscripten's fiber API. This is what makes PHP Fibers run.                    |
| `test/prototype/fiber-prototype.c` | The seven things PHP does to a `ucontext_t`, reproduced outside PHP so a mistake shows up in seconds instead of after an hour-long build.    |
| `scripts/check-prototype.sh`       | Builds and runs that prototype under four Asyncify configurations and checks each behaves as expected.                                       |
| `scripts/asyncify-advise-list.mjs` | Turns an `ASYNCIFY_ADVISE=1` build log into an `ASYNCIFY_ONLY` list.                                                                         |
| `upstream/`                        | A checkout of WordPress Playground. Not committed; run `git clone --depth 1 https://github.com/WordPress/wordpress-playground.git upstream`. |


Why PHP Fibers abort, in one paragraph
--------------------------------------

PHP switches stacks for a `Fiber` using assembly borrowed from Boost.Context.
There is no assembly in WebAssembly, so the php-wasm build passes
`./configure --disable-fiber-asm`, which makes PHP fall back to the POSIX
`getcontext` / `makecontext` / `swapcontext` trio instead. Emscripten has no
implementation of those, so it links them to a stub that calls `abort()`. The
first `Fiber::suspend()` reaches the stub and the runtime dies.

Emscripten does have stack switching of its own —
`emscripten_fiber_init`, `emscripten_fiber_init_from_current_context` and
`emscripten_fiber_swap` — and its documentation describes the API as "similar
to, but distinct from, POSIX ucontext". `src/ucontext-emscripten.c` supplies
the missing distinctness.

Two details make this smaller than it sounds. PHP calls
`makecontext(handle, fn, 0)` with **zero** arguments, so none of the variadic
argument marshalling that makes a general `makecontext` awkward is needed on
the path that matters. And PHP only ever touches `uc_stack` and `uc_link` in
the `ucontext_t`, which leaves the 200 bytes of register-save space that
WebAssembly has no use for free to hold the Emscripten fiber instead — no
side table, no extra allocation, nothing whose lifetime we would have to
track without a `destroycontext` to hook.


Running the prototype checks
----------------------------

Needs `emcc` on the path (Homebrew's `emscripten` will do) and Node.

```
scripts/check-prototype.sh
```

It builds four ways and expects a specific outcome from each:

| Configuration                                       | Expected  | Why it is in the list                                                                                                                                                    |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| plain Asyncify                                      | passes    | If this breaks, the shim is wrong.                                                                                                                                       |
| `ASYNCIFY_IGNORE_INDIRECT` alone                    | **fails** | A fiber is entered through a function pointer. Declare indirect calls safe and nothing pauses the fiber's entry frame. Kept as a case so the reason stays on the record. |
| `IGNORE_INDIRECT` + a complete `ASYNCIFY_ONLY` list | passes    | php-wasm's actual shape, and the case that decides whether any of this can ship. Naming a function in the only-list instruments it even when it is reached indirectly.   |
| only-list without `IGNORE_INDIRECT`                 | passes    | Shows the only-list is doing the work rather than two flags cancelling out.                                                                                              |

The third row is the useful finding: php-wasm's size-driven Asyncify settings
do not rule out fibers, so long as every frame between the entry point and
the swap is named in the only-list.
