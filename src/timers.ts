/**
 * A cancellable one-shot timer, shared by the module's various debounce/retry/coalesce timers so
 * each one is not its own hand-rolled `NodeJS.Timeout | null` field.
 */
export class RestartableTimer {
	#timer: NodeJS.Timeout | null = null

	/** Arm the timer, replacing any pending firing - each call resets the window. */
	restart(ms: number, fn: () => void): void {
		this.cancel()
		this.#timer = setTimeout(() => {
			this.#timer = null
			fn()
		}, ms)
	}

	/** Arm the timer only if nothing is already pending, so a burst of calls coalesces into one firing. */
	coalesce(ms: number, fn: () => void): void {
		if (this.#timer) return
		this.#timer = setTimeout(() => {
			this.#timer = null
			fn()
		}, ms)
	}

	cancel(): void {
		if (this.#timer) {
			clearTimeout(this.#timer)
			this.#timer = null
		}
	}
}
