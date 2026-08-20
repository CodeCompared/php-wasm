Licensing and attribution
=========================

This project is released under **GPL-2.0-or-later**, the full text of which is
in `LICENSE`. That is not a free choice: the work is derived from WordPress
Playground's php-wasm build, which is GPL-2.0-or-later, and PHP itself, so the
same terms carry through.


What is original here
---------------------

- `src/ucontext-emscripten.c` and `src/ucontext-emscripten.h` — a POSIX
  `ucontext(3)` implementation for WebAssembly on top of Emscripten's fiber
  API. Written for this project and intended for contribution upstream.
- `test/`, `scripts/`, `docs/` — the probe harness, the standalone prototype,
  the build and diagnostic tooling, and the written findings.


What is derived
---------------

- `patches/0001` … `patches/0003` are diffs against
  <https://github.com/WordPress/wordpress-playground>, so they contain that
  project's code as context and as modified lines. Copyright remains with the
  WordPress contributors, under GPL-2.0-or-later.
- Anything built by `scripts/build-php.sh` contains PHP itself (the PHP
  License), WordPress Playground's php-wasm glue (GPL-2.0-or-later), and the
  libraries that build links in — OpenSSL, libxml2, SQLite, libcurl, zlib,
  libpng, libjpeg, libwebp, GD, libzip, oniguruma and others, each under its
  own terms. A release built from this repository carries all of them, and
  their licenses travel with the PHP source it is built from rather than being
  restated here.

The upstream checkout that `scripts/build-php.sh` drives is not committed here
and is not redistributed by this repository; it is cloned from WordPress
Playground at build time.
