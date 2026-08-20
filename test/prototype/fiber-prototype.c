/*
 * fiber-prototype.c — exercises the ucontext shim the way PHP does.
 *
 * This is not a test of PHP.  It is a copy of the seven things PHP's fiber
 * code actually does to a ucontext_t, run outside PHP so that a mistake in
 * the shim shows up in seconds rather than after an hour-long PHP build:
 *
 *   1. allocate a stack, getcontext(), fill in uc_stack, uc_link = NULL,
 *      makecontext(handle, trampoline, 0)          — zero arguments
 *   2. hand swapcontext() a "from" context that was never initialized,
 *      because zend_fiber_init() allocates the main context with emalloc()
 *      and never calls getcontext() on it
 *   3. pass data between the two stacks through a global pointer, which is
 *      how PHP moves its zend_fiber_transfer across
 *   4. suspend from inside a nested call, not from the entry function
 *   5. resume, repeatedly
 *   6. run two fibers at once and switch straight between them, which PHP
 *      calls a symmetric coroutine
 *   7. do all of it again on a fresh main context, the way a second HTTP
 *      request would
 *
 * Prints one line per check and exits non-zero if any of them fails.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ucontext.h>

/* ---- test scaffolding ---------------------------------------------- */

static int failures;
static int checks;

static void check(int ok, const char *what)
{
	checks++;
	if (!ok) {
		failures++;
	}
	printf("%s %s\n", ok ? "ok  " : "FAIL", what);
	fflush(stdout);
}

/* ---- a stand-in for zend_fiber_stack ------------------------------- */

#define STACK_SIZE (256 * 1024)

typedef struct {
	void *memory;
	ucontext_t ucontext; /* embedded, exactly as PHP embeds it */
} fiber_stack;

static fiber_stack *stack_allocate(void)
{
	fiber_stack *stack = malloc(sizeof(*stack));
	stack->memory = malloc(STACK_SIZE);
	return stack;
}

static void stack_free(fiber_stack *stack)
{
	free(stack->memory);
	free(stack);
}

/*
 * PHP's zend_fiber_init_context, transcribed.
 */
static void init_context(fiber_stack *stack, void (*entry)(void))
{
	ucontext_t *handle = &stack->ucontext;

	getcontext(handle);

	handle->uc_stack.ss_size = STACK_SIZE;
	handle->uc_stack.ss_sp = stack->memory;
	handle->uc_stack.ss_flags = 0;
	handle->uc_link = NULL;

	makecontext(handle, entry, 0);
}

/* ---- the transfer PHP passes between stacks ------------------------ */

struct transfer {
	ucontext_t *back_to;
	int value;
};

static struct transfer *transfer_data;

/*
 * PHP's zend_fiber_switch_context, transcribed down to the global handoff.
 */
static void switch_context(ucontext_t *from, ucontext_t *to, struct transfer *t)
{
	transfer_data = t;
	swapcontext(from, to);
	/* The struct may have lived on the other stack, so copy it back. */
	*t = *transfer_data;
}

/* ---- check 1-5: one fiber, suspending from a nested call ----------- */

static ucontext_t main_context;
static fiber_stack *stack_a;
static int entry_ran;
static int deep_calls;
static int values_seen[4];
static int values_seen_count;

static void suspend_back(int value)
{
	struct transfer t;
	t.back_to = &stack_a->ucontext;
	t.value = value;
	switch_context(&stack_a->ucontext, &main_context, &t);
	/* Resumed.  Record what the resumer sent us. */
	if (values_seen_count < 4) {
		values_seen[values_seen_count++] = t.value;
	}
}

static void nested_three_deep(int depth, int value)
{
	char padding[64];
	memset(padding, depth, sizeof(padding));
	deep_calls++;

	if (depth > 0) {
		nested_three_deep(depth - 1, value);
		/*
		 * Touch the padding after the recursive call so the compiler
		 * cannot discard it: this frame must still be intact after a
		 * suspend and resume happened further down.
		 */
		if (padding[0] != (char)depth) {
			check(0, "C stack frame survived a suspend");
		}
		return;
	}

	suspend_back(value);
}

static void fiber_a_entry(void)
{
	entry_ran = 1;

	/* Suspend from the entry function itself. */
	suspend_back(10);

	/* Suspend from three frames down. */
	nested_three_deep(3, 20);

	/* And once more, to prove resumption is repeatable. */
	suspend_back(30);

	/* Fall through to the final switch PHP's trampoline performs. */
	{
		struct transfer t;
		t.back_to = NULL;
		t.value = 99;
		switch_context(&stack_a->ucontext, &main_context, &t);
	}

	check(0, "a dead fiber was resumed, which must not happen");
	abort();
}

static void one_fiber_start_suspend_resume(void)
{
	struct transfer t;
	int i;
	const int sends[3] = { 11, 21, 31 };

	stack_a = stack_allocate();
	init_context(stack_a, fiber_a_entry);

	memset(&t, 0, sizeof(t));
	t.value = 0;

	/*
	 * The very first switch.  main_context has never been through
	 * getcontext(); it is whatever malloc handed back.  This mirrors PHP
	 * exactly and is the case a naive shim gets wrong.
	 */
	switch_context(&main_context, &stack_a->ucontext, &t);
	check(entry_ran, "the fiber's entry function ran");
	check(t.value == 10, "a value came back from the fiber's first suspend");

	for (i = 0; i < 3; i++) {
		t.value = sends[i];
		switch_context(&main_context, &stack_a->ucontext, &t);
	}

	check(deep_calls == 4, "the fiber suspended from four frames down");
	check(t.value == 99, "the fiber ran to its end and switched back once more");
	check(values_seen_count == 3 && values_seen[0] == 11
		&& values_seen[1] == 21 && values_seen[2] == 31,
		"every resume delivered its value into the fiber");

	stack_free(stack_a);
}

/* ---- check 6: two fibers switching directly between each other ----- */

static fiber_stack *stack_b;
static fiber_stack *stack_c;
static char ping_pong[16];
static int ping_pong_len;

static void note(char c)
{
	if (ping_pong_len < (int)sizeof(ping_pong) - 1) {
		ping_pong[ping_pong_len++] = c;
	}
}

static void fiber_b_entry(void)
{
	struct transfer t;
	memset(&t, 0, sizeof(t));

	note('B');
	switch_context(&stack_b->ucontext, &stack_c->ucontext, &t); /* B -> C */
	note('B');
	switch_context(&stack_b->ucontext, &main_context, &t);      /* B -> main */
	abort();
}

static void fiber_c_entry(void)
{
	struct transfer t;
	memset(&t, 0, sizeof(t));

	note('C');
	switch_context(&stack_c->ucontext, &stack_b->ucontext, &t); /* C -> B */
	abort();
}

static void two_fibers_symmetric(void)
{
	struct transfer t;
	memset(&t, 0, sizeof(t));

	stack_b = stack_allocate();
	stack_c = stack_allocate();
	init_context(stack_b, fiber_b_entry);
	init_context(stack_c, fiber_c_entry);

	switch_context(&main_context, &stack_b->ucontext, &t);

	ping_pong[ping_pong_len] = '\0';
	check(strcmp(ping_pong, "BCB") == 0,
		"two fibers switched straight into each other and back to main");

	stack_free(stack_b);
	stack_free(stack_c);
}

/* ---- check 7: a second request, with a fresh main context ---------- */

static ucontext_t *second_main;
static fiber_stack *stack_d;
static int second_request_ran;

static void fiber_d_entry(void)
{
	struct transfer t;
	memset(&t, 0, sizeof(t));
	second_request_ran = 1;
	switch_context(&stack_d->ucontext, second_main, &t);
	abort();
}

static void second_request(void)
{
	struct transfer t;
	memset(&t, 0, sizeof(t));

	/*
	 * A new main context, allocated and left uninitialized, exactly as a
	 * second call into zend_fiber_init() would produce.
	 */
	second_main = malloc(sizeof(ucontext_t));
	memset(second_main, 0xA5, sizeof(ucontext_t)); /* deliberate garbage */

	stack_d = stack_allocate();
	init_context(stack_d, fiber_d_entry);

	switch_context(second_main, &stack_d->ucontext, &t);
	check(second_request_ran,
		"a fiber started from a second, freshly allocated main context");

	stack_free(stack_d);
	free(second_main);
}

int main(void)
{
	printf("# ucontext shim prototype\n");

	one_fiber_start_suspend_resume();
	two_fibers_symmetric();
	second_request();

	printf("# %d checks, %d failures\n", checks, failures);
	return failures ? 1 : 0;
}
