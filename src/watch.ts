import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'

/** The shape every readable vapi keyword shares - enough to subscribe to one. */
export interface Watchable<T> {
	watch: (handler: (payload: T) => void, opts?: object) => Promise<VScript.Watcher>
}

/** `ensure_initial_read` makes a watch deliver a current value immediately. */
export const WATCH_OPTS = { ensure_initial_read: true }

/**
 * Register a batch of watches concurrently.
 *
 * Each subscription is an independent round trip to the device, and there are well over a hundred
 * of them; awaiting one at a time made discovery take about eleven seconds.
 */
export async function watchAll(pending: Array<Promise<void>>): Promise<void> {
	await Promise.all(pending)
	pending.length = 0
}

/**
 * Subscribe to one keyword, routing the watcher to `collect` for teardown.
 *
 * A keyword the device does not support should cost only itself, not every subscription queued
 * behind it, so failures are logged at debug and swallowed.
 */
export async function watchKeyword<T>(
	self: ModuleInstance,
	label: string,
	keyword: Watchable<T>,
	handler: (payload: T) => void,
	collect: (watcher: VScript.Watcher) => void,
): Promise<void> {
	try {
		collect(await keyword.watch(handler, WATCH_OPTS))
	} catch (e: any) {
		self.log('debug', `Could not watch ${label}: ${e?.message ?? e}`)
	}
}
