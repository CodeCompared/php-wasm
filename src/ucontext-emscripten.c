/*
 * ucontext-emscripten.c — a POSIX ucontext(3) implementation for WebAssembly,
 * built on Emscripten's fiber API.
 *
 * Why this exists
 * ---------------
 * PHP's Fiber class switches stacks.  On most platforms it does that with a
 * hand-written assembly routine borrowed from Boost.Context; when that is
 * turned off (./configure --disable-fiber-asm, which is what the php-wasm
 * build does, because the assembly is x86/ARM machine code and there is no
 * such thing in WebAssembly) PHP falls back to the POSIX ucontext functions:
 *
 *     getcontext()    save the current machine context into a ucontext_t
 *     makecontext()   point a saved context at a function and a fresh stack
 *     swapcontext()   save the current context and resume a different one
 *
 * WebAssembly has no machine registers to save, so Emscripten links those
 * three names to a stub that aborts the whole runtime the moment PHP calls
 * one.  That abort is what a reader sees today: starting any Fiber kills the
 * PHP instance and every later run in it.
 *
 * Emscripten does have its own stack-switching API — emscripten_fiber_init,
 * emscripten_fiber_init_from_current_context and emscripten_fiber_swap — and
 * its own documentation says it "is similar to, but distinct from, POSIX
 * ucontext".  This file supplies the missing distinctness: it implements the
 * three POSIX names in terms of the three Emscripten ones, so PHP compiles
 * and runs unchanged.
 *
 * What a WebAssembly context has to hold
 * --------------------------------------
 * Two stacks, not one.  Emscripten's Asyncify rewrites the program so that a
 * paused call stack is spilled into a side buffer — the "Asyncify stack" —
 * while addressable local variables continue to live on the ordinary C stack
 * in linear memory.  Resuming a fiber means restoring both.  POSIX only ever
 * hands us one stack (the one in uc_stack), so we split it: the low part
 * becomes the C stack, the high part becomes the Asyncify stack.  Splitting
 * rather than allocating on the side matters because POSIX has no
 * "destroycontext" call — there is no moment at which we would be told a
 * context is finished and could free a separate allocation.  Living inside
 * the caller's stack means the caller's own free() cleans up after us, and
 * one knob (PHP's zend.fiber_stack_size) still controls the whole cost.
 *
 * Where the bookkeeping lives
 * ---------------------------
 * Inside the ucontext_t the caller already owns.  Emscripten's ucontext_t
 * (from musl) carries a uc_mcontext of 88 bytes and 112 further bytes of
 * register spill space, all of it meaningless on WebAssembly, and all of it
 * after the three fields a caller may legitimately touch (uc_flags, uc_link,
 * uc_stack).  We overlay our own state on that dead space.  No side table, no
 * allocation, no lifetime to manage.
 *
 * License: this file is intended for the php-wasm build in WordPress
 * Playground and is released under the same terms, GPL-2.0-or-later.
 */

#include "ucontext-emscripten.h"

#include <emscripten/fiber.h>
#include <emscripten/stack.h>

#include <errno.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/*
 * How much of the caller's stack is set aside for the Asyncify stack.
 *
 * The Asyncify stack holds one entry per live call frame that has state to
 * preserve, so it grows with call depth rather than with the size of local
 * variables.  A quarter of the allocation is a deliberate over-provision:
 * PHP's default fiber stack on a 32-bit target is 1 MiB, so the split is
 * 768 KiB of C stack against 256 KiB of Asyncify stack, and the deepest
 * suspend a normal program performs uses a small fraction of the latter.
 *
 * Override at compile time with -DEMSCRIPTEN_UCONTEXT_ASYNCIFY_STACK_DIVISOR=N
 * to hand the Asyncify stack 1/N of the allocation.
 */
#ifndef EMSCRIPTEN_UCONTEXT_ASYNCIFY_STACK_DIVISOR
#define EMSCRIPTEN_UCONTEXT_ASYNCIFY_STACK_DIVISOR 4
#endif

/*
 * The Asyncify stack never shrinks below this, and the C stack is never
 * allowed to shrink below the same figure.  A context created with a stack
 * too small to satisfy both is refused rather than silently corrupted.
 */
#ifndef EMSCRIPTEN_UCONTEXT_MIN_ASYNCIFY_STACK
#define EMSCRIPTEN_UCONTEXT_MIN_ASYNCIFY_STACK (16 * 1024)
#endif

#ifndef EMSCRIPTEN_UCONTEXT_MIN_C_STACK
#define EMSCRIPTEN_UCONTEXT_MIN_C_STACK (16 * 1024)
#endif

/*
 * The Asyncify stack the original (non-fiber) call stack uses when it is
 * suspended.  There is exactly one original stack per program, so one buffer
 * suffices; it is static rather than allocated so that a context switch can
 * never fail for want of memory.
 */
#ifndef EMSCRIPTEN_UCONTEXT_MAIN_ASYNCIFY_STACK
#define EMSCRIPTEN_UCONTEXT_MAIN_ASYNCIFY_STACK (256 * 1024)
#endif

#define UC_MAGIC 0x75437478u /* "uCtx" */

/* Up to this many int arguments may be passed through makecontext(). */
#define UC_MAX_ARGS 8

/*
 * The state we keep for one context.  It is overlaid on the dead register
 * space of the caller's ucontext_t, starting at uc_mcontext — every field a
 * portable caller is entitled to read or write (uc_flags, uc_link, uc_stack)
 * sits before that point and is left alone.
 */
typedef struct {
	/*
	 * The fiber this context owns, when makecontext() built one.  The
	 * context that stands for the program's original stack owns nothing
	 * and points at the single static fiber instead.
	 */
	emscripten_fiber_t fiber;

	/*
	 * Which fiber struct to resume.  This is a pointer rather than the
	 * struct itself because Emscripten writes the saved stack position
	 * into the fiber *during* the swap: anything copied beforehand would
	 * be a snapshot taken one instant too early, and resuming from it
	 * rewinds onto a stack position that was never reached.
	 */
	emscripten_fiber_t *fiber_ptr;

	/* Set by makecontext(), read by the entry trampoline. */
	void (*entry)(void);
	int argc;
	int argv[UC_MAX_ARGS];

	/* Distinguishes a context we have prepared from uninitialized memory. */
	uint32_t magic;
	void *self;
} uc_state_t;

#define UC_STATE(ucp) ((uc_state_t *)(void *)&(ucp)->uc_mcontext)

/* Bytes available from uc_mcontext to the end of the struct. */
#define UC_STATE_ROOM (sizeof(ucontext_t) - offsetof(ucontext_t, uc_mcontext))

_Static_assert(sizeof(uc_state_t) <= UC_STATE_ROOM,
	"emscripten ucontext state does not fit in ucontext_t's register space");

/*
 * The fiber currently executing, or NULL when execution is on the program's
 * original stack.  Tracking this means swapcontext() never has to read the
 * ucontext_t it is saving into — which matters, because POSIX allows that
 * struct to be uninitialized, and PHP relies on it: zend_fiber_init() hands
 * swapcontext() a context it allocated with emalloc() and never passed to
 * getcontext().
 */
static emscripten_fiber_t *uc_current;

/* Backing store for the original stack's Asyncify data, see above. */
static emscripten_fiber_t uc_main_fiber;
static char uc_main_asyncify_stack[EMSCRIPTEN_UCONTEXT_MAIN_ASYNCIFY_STACK]
	__attribute__((aligned(16)));
static int uc_main_fiber_live;

static int uc_state_is_ready(const ucontext_t *ucp)
{
	const uc_state_t *state = UC_STATE((ucontext_t *)ucp);
	return state->magic == UC_MAGIC && state->self == (const void *)ucp;
}

/*
 * The function every fiber starts in.  Emscripten calls this with the fiber's
 * user_data; we recover the caller's function and its makecontext() arguments
 * and call it.
 *
 * It is deliberately not static.  php-wasm links with an Asyncify only-list,
 * which instruments a function only if the build can name it, and the name of
 * a static function is the optimizer's to change.
 *
 * POSIX says that when that function returns, execution continues in uc_link,
 * or the thread exits if uc_link is NULL.  PHP always sets uc_link to NULL
 * and its fiber entry point never returns, so the honest thing to do on
 * return is to follow uc_link when there is one and stop the program when
 * there is not — exactly what POSIX asks for, and what a mistake here should
 * look like rather than silently running on a dead stack.
 */
void emscripten_ucontext_trampoline(void *arg)
{
	ucontext_t *ucp = (ucontext_t *)arg;
	uc_state_t *state = UC_STATE(ucp);
	int argc = state->argc;
	const int *a = state->argv;

	switch (argc) {
	case 0:
		state->entry();
		break;
	case 1:
		((void (*)(int))state->entry)(a[0]);
		break;
	case 2:
		((void (*)(int, int))state->entry)(a[0], a[1]);
		break;
	case 3:
		((void (*)(int, int, int))state->entry)(a[0], a[1], a[2]);
		break;
	case 4:
		((void (*)(int, int, int, int))state->entry)(a[0], a[1], a[2], a[3]);
		break;
	case 5:
		((void (*)(int, int, int, int, int))state->entry)(
			a[0], a[1], a[2], a[3], a[4]);
		break;
	case 6:
		((void (*)(int, int, int, int, int, int))state->entry)(
			a[0], a[1], a[2], a[3], a[4], a[5]);
		break;
	case 7:
		((void (*)(int, int, int, int, int, int, int))state->entry)(
			a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
		break;
	default:
		((void (*)(int, int, int, int, int, int, int, int))state->entry)(
			a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7]);
		break;
	}

	if (ucp->uc_link) {
		setcontext(ucp->uc_link);
	}

	exit(0);
}

int getcontext(ucontext_t *ucp)
{
	if (!ucp) {
		errno = EINVAL;
		return -1;
	}

	/*
	 * There are no registers to save.  A context that has only been through
	 * getcontext() is not resumable on WebAssembly — POSIX would let you
	 * setcontext() back to the point of the call, and Asyncify cannot do
	 * that without having been told to unwind first.  What getcontext()
	 * does here is what every real caller uses it for: zero the struct so
	 * that the makecontext() that follows has a clean slate.
	 */
	memset(ucp, 0, sizeof(*ucp));
	return 0;
}

void makecontext(ucontext_t *ucp, void (*func)(void), int argc, ...)
{
	uc_state_t *state;
	char *stack;
	size_t total, asyncify_size, c_size;
	va_list args;
	int i;

	if (!ucp || !func) {
		return;
	}

	stack = (char *)ucp->uc_stack.ss_sp;
	total = ucp->uc_stack.ss_size;

	/*
	 * POSIX gives makecontext() no way to report failure, so a stack too
	 * small to carry both a C stack and an Asyncify stack has to be caught
	 * here.  Leaving the context unprepared makes the later swapcontext()
	 * fail loudly instead of running the fiber on a stack that overlaps
	 * something else.
	 */
	if (!stack || total < (size_t)(EMSCRIPTEN_UCONTEXT_MIN_C_STACK
			+ EMSCRIPTEN_UCONTEXT_MIN_ASYNCIFY_STACK)) {
		return;
	}

	if (argc < 0) {
		argc = 0;
	}
	if (argc > UC_MAX_ARGS) {
		argc = UC_MAX_ARGS;
	}

	state = UC_STATE(ucp);
	memset(state, 0, sizeof(*state));

	state->entry = func;
	state->argc = argc;

	va_start(args, argc);
	for (i = 0; i < argc; i++) {
		state->argv[i] = va_arg(args, int);
	}
	va_end(args);

	/*
	 * Split the caller's stack: C stack low, Asyncify stack high.  The C
	 * stack goes at the bottom on purpose — it grows downwards, so an
	 * overflow runs into whatever guard the caller placed below ss_sp
	 * (PHP maps guard pages there) rather than quietly eating the Asyncify
	 * stack above it.
	 */
	asyncify_size = total / EMSCRIPTEN_UCONTEXT_ASYNCIFY_STACK_DIVISOR;
	if (asyncify_size < EMSCRIPTEN_UCONTEXT_MIN_ASYNCIFY_STACK) {
		asyncify_size = EMSCRIPTEN_UCONTEXT_MIN_ASYNCIFY_STACK;
	}
	asyncify_size &= ~(size_t)15; /* keep both stacks 16-byte aligned */
	c_size = total - asyncify_size;

	emscripten_fiber_init(&state->fiber, emscripten_ucontext_trampoline, ucp,
		stack, c_size, stack + c_size, asyncify_size);
	state->fiber_ptr = &state->fiber;

	state->magic = UC_MAGIC;
	state->self = ucp;
}

int swapcontext(ucontext_t *from, const ucontext_t *to)
{
	uc_state_t *from_state, *to_state;
	emscripten_fiber_t *running, *next;

	if (!from || !to) {
		errno = EINVAL;
		return -1;
	}

	if (!uc_state_is_ready(to)) {
		/* Never prepared by makecontext(), or prepared and it failed. */
		errno = EINVAL;
		return -1;
	}

	/*
	 * Work out which fiber is running.  We ask our own bookkeeping rather
	 * than the `from` struct, because `from` may be uninitialized memory —
	 * POSIX says swapcontext() writes it, so a caller is entitled to hand
	 * us anything.
	 */
	running = uc_current;
	if (!running) {
		running = &uc_main_fiber;
		if (!uc_main_fiber_live) {
			emscripten_fiber_init_from_current_context(running,
				uc_main_asyncify_stack,
				sizeof(uc_main_asyncify_stack));
			uc_main_fiber_live = 1;
		}
	}

	/*
	 * Record the running fiber in `from` so a later swapcontext(_, from)
	 * can find its way back here.  When `from` is the original stack this
	 * writes a pointer to the single static main fiber; when it is a fiber
	 * created by makecontext() it rewrites the same value it already held.
	 */
	from_state = UC_STATE(from);
	if (from_state->magic != UC_MAGIC || from_state->self != from) {
		memset(from_state, 0, sizeof(*from_state));
		from_state->magic = UC_MAGIC;
		from_state->self = from;
	}
	from_state->fiber_ptr = running;

	to_state = UC_STATE((ucontext_t *)to);
	next = to_state->fiber_ptr;

	uc_current = (next == &uc_main_fiber) ? NULL : next;

	emscripten_fiber_swap(running, next);

	/* Back on this stack again. */
	uc_current = (running == &uc_main_fiber) ? NULL : running;

	return 0;
}

int setcontext(const ucontext_t *ucp)
{
	static ucontext_t discard;

	if (!ucp) {
		errno = EINVAL;
		return -1;
	}

	/*
	 * setcontext() abandons the current stack instead of saving it.  There
	 * is nothing in the Emscripten fiber API that discards a stack, so the
	 * closest honest behavior is to swap away and never come back: the
	 * context we save into is a throwaway nobody can resume.
	 */
	return swapcontext(&discard, ucp);
}
