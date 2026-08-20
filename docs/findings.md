What was actually wrong, and what fixed it
==========================================

Measured against `@php-wasm/web-8-5` **3.1.50** (PHP 8.5.8, asyncify) and
against builds from this tree, in a real headless Chromium, on 2026-08-19 and
2026-08-20. Every claim below came out of `test/probe/run-probes.mjs`; nothing
here is inferred from reading code alone.

Run the "before" picture yourself with `npm run probe:published`, and the
"after" picture with `npm run probe:local` once `scripts/build-php.sh` has
produced a build.


The short version
-----------------

|                                            | Before                       | After                               |
| ------------------------------------------ | ---------------------------- | ----------------------------------- |
| `new Fiber(...)` and `Fiber::suspend()`    | aborts the runtime           | works                               |
| a Fiber suspending from a nested call      | aborts the runtime           | works                               |
| five Fibers interleaving                   | aborts the runtime           | works                               |
| `Fiber::throw()` into a suspended Fiber    | aborts the runtime           | works                               |
| the abort message when a symbol is missing | `missing function: ${name}`  | names the function                  |
| `popen()`                                  | kills the browser tab        | returns `false` with a warning      |
| `file_get_contents('https://…')`           | traps on `unreachable`       | returns `false`                     |
| `curl_exec()`                              | traps on `unreachable`       | returns `false`, `curl_error()` set |
| `fsockopen()`                              | traps on `unreachable`       | returns a handle whose reads fail   |
| `intl`                                     | thought to need compiling in | already shipped; loads today        |

Cost of all of it: **5,252 bytes** of WebAssembly, on a 21,019,221-byte
binary. 0.025%.


1. Fibers aborted the runtime
-----------------------------

**What a reader saw.** Any use of PHP's `Fiber` class ended the run with

```
Aborted(missing function: ${name}). Build with -sASSERTIONS for more info.
```

**Why.** PHP switches fiber stacks with assembly borrowed from Boost.Context.
There is no assembly in WebAssembly, so the build passes
`./configure --disable-fiber-asm`, which makes PHP fall back to the POSIX
`getcontext` / `makecontext` / `swapcontext` trio instead. Emscripten has no
implementation of those three, so php-wasm listed them as "known undefined"
and linked them to a stub that calls `abort()`. The first `Fiber::suspend()`
reached the stub.

**The fix** is `src/ucontext-emscripten.c`: an implementation of those three
in terms of Emscripten's own fiber API, which its documentation describes as
"similar to, but distinct from, POSIX ucontext".

Two things made it smaller than expected:

- **PHP calls `makecontext(handle, fn, 0)` — zero arguments.** None of the
  variadic argument marshalling that makes a general `makecontext` awkward is
  needed on the path that matters.
- **PHP touches only `uc_stack` and `uc_link`.** That leaves the roughly 200
  bytes of register-save space in a `ucontext_t` — meaningless on WebAssembly
  — free to hold the Emscripten fiber. No side table, no allocation, and so
  nothing whose lifetime has to be tracked, which matters because POSIX has no
  `destroycontext` to hook.

Two things had to be got right:

- **Two stacks, not one.** Asyncify spills a paused call stack into a side
  buffer while addressable locals stay on the ordinary C stack, so resuming
  needs both. POSIX hands over one stack, so it is split: C stack low, so an
  overflow meets the guard page PHP maps below it, and Asyncify stack high.
- **`swapcontext` must never read the context it is saving into.** POSIX says
  that struct is written, not read, so a caller may pass anything — and PHP
  does. `zend_fiber_init()` allocates the main fiber context with `emalloc()`
  and hands it to `swapcontext()` without ever calling `getcontext()` on it.
  The shim tracks which fiber is running in a variable of its own instead.

  This is the one a naive implementation gets wrong, and it is why
  `test/prototype/fiber-prototype.c` exists: it reproduces the seven things
  PHP does to a `ucontext_t` outside PHP, uninitialized main context included,
  so a mistake shows up in seconds rather than after an hour-long build.

### The part that nearly stopped it: `ASYNCIFY_ONLY`

php-wasm does not link with plain Asyncify. To keep the download near 21 MB it
passes `-s ASYNCIFY_IGNORE_INDIRECT=1` together with an `ASYNCIFY_ONLY` list
naming about two thousand functions by hand. Both settings are assertions that
certain code never needs to pause, and both are false for fibers.

`scripts/check-prototype.sh` builds the prototype four ways to pin this down:

| Configuration                            | Result                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| plain Asyncify                           | passes                                                                                                                                 |
| `IGNORE_INDIRECT` alone                  | **fails** — a fiber is entered through a function pointer, so with indirect calls declared safe nothing pauses the fiber's entry frame |
| `IGNORE_INDIRECT` + a complete only-list | passes                                                                                                                                 |
| only-list without `IGNORE_INDIRECT`      | passes                                                                                                                                 |

The third row is the finding that made the work shippable: **naming a function
in the only-list instruments it even though it is reached indirectly.** So the
fix in the real build is to name the fiber call path — every frame from
`Fiber::suspend()` down to `swapcontext` — and the shim's entry trampoline is
deliberately not `static`, because a build that instruments only what it can
name cannot name a symbol the optimizer is free to rename.


2. The abort message never named anything
-----------------------------------------

The stub was written as `abort('missing function: ${name}')` — single quotes,
so the placeholder was never a placeholder. Every missing-symbol abort in the
history of this build has printed the four characters `${name}`.

Switching to a template literal is not enough, and this is the interesting
part: **Emscripten emits a library function by converting it to a string**,
which drops anything it closed over. A function referring to `name` would
compile to an abort that says `${name}` for a different reason. The name has
to be baked into the source text, which Emscripten supports by accepting a
string in place of a function.


3. `popen()` killed the browser tab
-----------------------------------

Worse than an abort: the whole browsing context died, and Playwright reported
the evaluation promise being garbage collected — which reads like a bug in the
caller rather than in PHP.

`js_popen_to_file` runs inside `Asyncify.handleSleep`. By the time that
callback runs the WebAssembly stack has already been unwound, and `wakeUp()`
is what rewinds it; **returning a value does nothing at all.** The
`SPAWN_UNSUPPORTED` path — the path a plain web build always takes, because
there is no process support in a browser — did

```js
if (e.code === 'SPAWN_UNSUPPORTED') {
    return 1;
}
```

so the runtime stayed unwound forever. Nothing ever resumed it, and the page
died holding a promise that could never settle.

Every path out now calls `wakeUp` exactly once, including a new handler for a
spawn that fails *after* returning, and the C side checks for the null pointer
it can now receive instead of calling `fopen()` on a path built from `1`.

`popen()` returns `false` with a warning, which is what `popen(3)` does and
what PHP code already handles.


4. Every network call trapped — and only in Chrome
--------------------------------------------------

`fsockopen()`, `file_get_contents('https://…')` and `curl_exec()` all ended in
`RuntimeError: unreachable`, taking the runtime with them.

The cause is a check that asks the **browser** a question about the **build**:

```js
if (!("Suspending" in WebAssembly)) {
    // synchronous connect: the Asyncify path
}
// otherwise: unwind the stack and wait for the WebSocket
```

`WebAssembly.Suspending` is JSPI. The intent was "if this browser has no JSPI
then this must be an Asyncify build" — true only for as long as no browser
shipped JSPI. Chrome has since shipped it, so **an Asyncify build running in
Chrome has been taking the branch written for JSPI builds**, which unwinds the
stack in a place an Asyncify build cannot, and traps.

The same binary in Firefox or Safari still fails gracefully, because those
browsers still answer no. That is worth stating plainly: this was not a
long-standing limitation of the WebAssembly build. It is a regression that
arrived in Chrome, in a binary that had not changed.

`ASYNCIFY` is a build setting and answers the question that was actually being
asked — 1 for Asyncify, 2 for JSPI — so the branch is now decided at build
time. Measured afterwards:

- `file_get_contents('https://example.com')` returns `false`.
- `curl_exec()` returns `false` and `curl_error()` reads
  `Failed to connect to example.com port 443: Connection refused`.
- `fsockopen()` returns a handle rather than `false`, and reads from it return
  `''`. The synchronous path does not wait for the connection, so the failure
  surfaces at the first read instead of at `connect()`. That is worse than
  `false` and it is what Firefox and Safari have always done here; it is
  recoverable, which an abort is not.

**What was ruled out along the way**, so nobody repeats it:

- *Missing names in `ASYNCIFY_ONLY`.* Every one of the fourteen frames in the
  trapping stack was already on the list.
- *The 4 KB default `ASYNCIFY_STACK_SIZE`.* Raising it to 64 KB left the traps
  untouched.

`scripts/trace-trap.mjs` is what made this legible: a shipping build strips the
WebAssembly name section, so a trap reports bare function indices. Build with
`WITH_FUNCTION_NAMES=yes` and the same trace names names.


5. `errno` was never set
------------------------

`___errno_location()` **returns** the address of `errno`. All six call sites in
the Emscripten library passed the code to it as an argument:

```js
___errno_location(ERRNO_CODES.ENOSYS);   // sets nothing
```

So a failure meant to reach PHP as `ENOSYS` or `EBADF` arrived as whatever
`errno` happened to hold from earlier. There is a helper now that writes
through the returned pointer.


6. `intl` needs no rebuild at all
---------------------------------

This one contradicts the brief, which expected `intl` to have to be compiled
in, with ICU data making the download much larger.

It is already shipped. `@php-wasm/web-8-5` 3.1.50 contains
`asyncify/extensions/intl/intl.so`, and `@php-wasm/universal` already has a
supported way to load it: `resolvePHPExtension` plus
`withResolvedPHPExtensions`, when the runtime is created.

Not through `dl()`. PHP scans its `.ini` files once, at startup, and by the
time PHP code could call `dl()` that scan is over. That is why `dl('intl.so')`
appeared to prove there was no route to it.

Two things fail silently and have to be got right:

- **The package ships `intl.so` and no ICU data whatsoever.** Without it the
  extension loads, `INTL_ICU_VERSION` reports `74.2`, and every constructor
  throws `number formatter creation failed` — which reads like a broken build
  rather than a missing file. The data has to be staged at
  `/internal/shared/icudt74l.dat`, the name `intl.so` is compiled to look for,
  with `ICU_DATA` pointing at the directory. The file lives in the upstream
  repository at `packages/php-wasm/compile/shared/intl/data/icu.dat`.
- **A caller-supplied `extraFiles` takes file *contents*, not locations.** The
  URL-and-`vfsPath` shape belongs to published manifests; passing it here
  stages nothing and reports nothing.

Verified against the published package straight from the CDN — no local build
involved: German decimals `1.234.567,891`, Japanese currency `￥1,234`, French
long dates `19 août 2026`, Swedish collation `apple,zebra,ähly`, and Unicode
normalization.

### What it costs

|                | raw      | gzip -9  | brotli -q5 |
| -------------- | -------- | -------- | ---------- |
| `php_8_5.wasm` | 20.05 MB | 7.47 MB  | 7.16 MB    |
| `intl.so`      | 7.71 MB  | 1.89 MB  | 1.62 MB    |
| `icu.dat`      | 30.78 MB | 11.55 MB | 9.54 MB    |

**The data file is the problem, not the extension.** `intl.so` adds about a
quarter to the transfer; `icu.dat` adds half again as much as PHP itself. ICU
can be built with a data filter that keeps only chosen locales and features,
which is the obvious way to make this affordable and is not attempted here.


7. A correction to the brief
----------------------------

> The instance is dead afterwards; every later call fails too.

Measured: it is not. After a Fiber abort, a later `php.run()` on the same
instance still works and returns its output. The abort loses that one run,
not the instance. Milder than assumed, and the `instance-survives-a-fiber`
probe records the measurement so it stays recorded.


Still open
----------

- **`fsockopen()` returns a handle instead of `false`.** Recoverable, but the
  failure surfaces one call later than it should. Fixing it properly means
  making the Asyncify build wait for the WebSocket the way the JSPI build
  does, which is exactly the path that traps; the trap's cause is not yet
  known, and §4 lists what has been ruled out.
- **`gmp` and `sodium`** are still absent and were not attempted.
- **`exec`, `shell_exec`, `system`, `passthru`, `proc_open` and `popen` are
  still declared**, so `function_exists()` says yes for all six and PHP code
  takes the branch that uses them. They no longer kill the tab, which was the
  urgent half. Making them honest is a `disable_functions` entry in the
  runtime's `php.ini` — since PHP 8.0 a disabled function is removed from the
  function table, so `function_exists()` correctly returns false — but that is
  a consumer-side setting and it would take process spawning away from
  consumers who legitimately provide a spawn handler, so it is not something
  to change in the build for everyone.
- **A trimmed ICU data file**, per §6.
