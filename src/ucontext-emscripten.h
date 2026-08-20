/*
 * ucontext-emscripten.h — declarations for the WebAssembly ucontext(3) shim.
 *
 * Emscripten ships <ucontext.h> and the musl ucontext_t layout but no
 * implementation, so the three names below resolve to an abort stub at link
 * time.  ucontext-emscripten.c defines them for real.  Nothing needs to
 * include this header to use them — it exists so the implementation and any
 * test can agree on the same declarations, and to keep the tuning knobs
 * documented in one place.
 *
 * Released under GPL-2.0-or-later, the same terms as the php-wasm build it is
 * written for.
 */

#ifndef UCONTEXT_EMSCRIPTEN_H
#define UCONTEXT_EMSCRIPTEN_H

#ifndef __EMSCRIPTEN__
#error "ucontext-emscripten.c is only meaningful in an Emscripten build"
#endif

#include <stdarg.h>
#include <ucontext.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * The function every fiber starts in.  It is not part of POSIX and nothing
 * should call it; it has external linkage and a name of its own only so that
 * the build can name it in Asyncify's only-list.  A build that instruments
 * only the functions it lists — which is what php-wasm does, to keep the
 * download down — has to be able to say "instrument this one", and a static
 * function the optimizer is free to rename cannot be said.
 */
void emscripten_ucontext_trampoline(void *arg);

int getcontext(ucontext_t *ucp);
void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...);
int setcontext(const ucontext_t *ucp);
int swapcontext(ucontext_t *from, const ucontext_t *to);

#ifdef __cplusplus
}
#endif

#endif /* UCONTEXT_EMSCRIPTEN_H */
