Ready-to-send pull request description
======================================

**Nothing has been pushed and no pull request has been opened.** This is the
text to use if you decide to send one, and the branch is `php-wasm-fibers` in
the `upstream/` checkout — three commits on top of `a9835e1`, also exported to
`patches/` as `0001` through `0003`.

To send it:

```
cd upstream
gh repo fork WordPress/wordpress-playground --remote-name fork --clone=false
git push fork php-wasm-fibers
gh pr create --repo WordPress/wordpress-playground \
    --base trunk --head <your-github-user>:php-wasm-fibers \
    --title "Make PHP Fibers work, and make network and process failures recoverable" \
    --body-file ../docs/upstream-pull-request.md
```

Check `--base` before running it; upstream's default branch may not be
`trunk`. The three commits are independent and can be sent separately —
the second one stands on its own and is arguably the more urgent, since it
is a live regression rather than a long-standing gap.

---

Make PHP Fibers work, and make network and process failures recoverable
-----------------------------------------------------------------------

Four things in the web build end the run in a way PHP code cannot catch. Two
of them are worse than that: one kills the browser tab, and one is a
regression that arrived when Chrome shipped JSPI.

Everything below was measured in headless Chromium against
`@php-wasm/web-8-5` 3.1.50 (PHP 8.5.8, asyncify) and against builds from this
branch. The whole change costs **5,252 bytes** of WebAssembly on a
21,019,221-byte binary — 0.025%.

### 1. Fibers abort the runtime

```php
$fiber = new Fiber(function () { Fiber::suspend(); });
$fiber->start();
```

```
Aborted(missing function: ${name}). Build with -sASSERTIONS for more info.
```

`--disable-fiber-asm` makes PHP switch fiber stacks through POSIX
`getcontext` / `makecontext` / `swapcontext`, and all three are on the
known-undefined list, linked to a stub that calls `abort()`.

This adds `ucontext-emscripten.c`, implementing them on top of
`emscripten_fiber_init` / `_init_from_current_context` / `_swap` — which the
Emscripten docs describe as "similar to, but distinct from, POSIX ucontext",
and which is asyncify-only, matching this variant.

It is smaller than it sounds. PHP calls `makecontext(handle, fn, 0)` with zero
arguments, so none of the variadic marshalling is needed; and PHP touches only
`uc_stack` and `uc_link`, which leaves the `ucontext_t`'s register-save space
— dead weight on WebAssembly — free to hold the Emscripten fiber, so there is
no side table and nothing to free. That last point matters, because POSIX has
no `destroycontext` to hook. The single stack POSIX hands over is split: C
stack low, so an overflow meets the guard page PHP maps below it, Asyncify
stack high.

The one subtlety worth flagging for review: **`swapcontext` never reads the
context it saves into.** POSIX says that struct is written, not read, and PHP
relies on it — `zend_fiber_init()` allocates the main fiber context with
`emalloc()` and passes it to `swapcontext()` without ever calling
`getcontext()` on it. The shim tracks the running fiber itself instead.

The fiber call path is added to `ASYNCIFY_ONLY`, since a fiber suspends by
unwinding the whole WebAssembly stack. Naming a function there also overrides
`ASYNCIFY_IGNORE_INDIRECT` for it, which fibers need: a fiber is entered
through a function pointer.

Verified: start, suspend, resume, return values, suspending from three frames
below the entry function, five fibers interleaving, and `Fiber::throw()` into
a suspended fiber.

### 2. The abort message has never named the missing function

`abort('missing function: ${name}')` — single quotes, so every
missing-symbol abort in this build's history has printed the literal
characters `${name}`. That is why the Fiber abort above says nothing useful.

A template literal alone does not fix it: Emscripten emits a library function
by stringifying it, which drops anything it closed over. The name is baked
into the source text instead.

### 3. `popen()` kills the browser tab

`js_popen_to_file` runs inside `Asyncify.handleSleep`, where the WebAssembly
stack has already been unwound and `wakeUp()` is what rewinds it — returning a
value does nothing. The `SPAWN_UNSUPPORTED` path, which is the path a plain
web build always takes, did `return 1` and never called `wakeUp`, so the
runtime stayed unwound forever and the page died holding a promise that could
never settle.

Every path out now wakes the runtime exactly once, including a new handler for
a spawn that fails after returning; and `wasm_popen` checks for the null it
can now receive rather than calling `fopen()` on a path built from the address
`1`. `popen()` returns `false` with a warning.

### 4. Every `connect()` traps, in Chrome only

```js
if (!("Suspending" in WebAssembly)) { /* the Asyncify path */ }
```

This asks the **browser** a question about the **build**. It agreed with the
truth only for as long as no browser shipped JSPI. Since Chrome did, an
Asyncify build running in Chrome takes the branch written for JSPI builds,
which unwinds the stack in a place an Asyncify build cannot — so `fsockopen()`,
`https://` streams and `curl_exec()` all trap on `unreachable` and take the
runtime with them. The same binary in Firefox or Safari still fails
gracefully. **This is a regression in a binary that did not change.**

`ASYNCIFY` is a build setting and answers the question that was actually being
asked. Afterwards: `file_get_contents()` on https returns `false`,
`curl_exec()` returns `false` with `curl_error()` reading `Failed to connect
to example.com port 443: Connection refused`.

`fsockopen()` still returns a handle rather than `false`, because the
synchronous path does not wait for the connection and the failure surfaces at
the first read. That is what Firefox and Safari have always done here. Making
it return `false` means making the Asyncify build wait the way the JSPI build
does, which is the path that traps; I could not find the cause, and I ruled
out two things worth recording: every one of the fourteen frames in the
trapping stack was already in `ASYNCIFY_ONLY`, and raising
`ASYNCIFY_STACK_SIZE` from the 4 KB default to 64 KB changed nothing.

### 5. `errno` was never set

`___errno_location()` *returns* the address of `errno`; all six call sites
passed the code to it as an argument, which sets nothing. A failure meant to
reach PHP as `ENOSYS` or `EBADF` arrived as whatever `errno` held from
earlier.

### Also here

`WITH_FUNCTION_NAMES=yes` keeps the WebAssembly name section. The Dockerfile's
own instructions for an Asyncify `unreachable` are to read the stack and add
every name on it to `ASYNCIFY_ONLY`, which a stripped build makes impossible —
the stack is bare function indices. Off by default.

### Not in this branch

`intl` turns out to need no build change at all: `asyncify/extensions/intl/intl.so`
already ships and `resolvePHPExtension` already loads it. But **the package
ships no ICU data**, so the extension loads, `INTL_ICU_VERSION` reports 74.2,
and every constructor throws `number formatter creation failed` — which reads
like a broken build rather than a missing file. Staging
`compile/shared/intl/data/icu.dat` at `/internal/shared/icudt74l.dat` with
`ICU_DATA` set makes it work, verified against the published package. Shipping
that file, or a locale-filtered version of it, seems worth doing; it is 30.78 MB
raw and 11.55 MB gzipped, against 7.47 MB gzipped for PHP itself, so a filtered
build is probably the answer. Happy to open that separately.
