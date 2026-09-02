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

/**
 * A named-table row, whose name is a keyword like any other.
 *
 * `row_name()` is a one-shot read, but the same value sits at `row_name_status` on the row's own
 * KWL, so a rename made in the device's web UI can be followed live instead of going stale until
 * the next reconnect.
 */
export interface NamedRow {
	raw: {
		watch: (path: { kw: any }, handler: (payload: any) => void, opts?: object) => Promise<VScript.Watcher>
	}
}

/**
 * Follow a row's name, applying `fallback` while the device reports a blank one.
 *
 * A name reaches dropdown choices, variable names and label values, so a change schedules the
 * rebuild that republishes all three - and only a change does, since the initial read arrives here
 * for every row at discovery.
 */
export async function watchRowName(
	self: ModuleInstance,
	id: string,
	row: NamedRow,
	fallback: string,
	apply: (name: string) => void,
	collect: (watcher: VScript.Watcher) => void,
): Promise<void> {
	let current: string | null = null
	await watchKeyword<unknown>(
		self,
		`${id}.row_name`,
		{ watch: async (handler, opts) => row.raw.watch({ kw: 'row_name_status' }, handler, opts) },
		(v) => {
			const trimmed = typeof v === 'string' ? v.trim() : ''
			const name = trimmed === '' ? fallback : trimmed
			if (name === current) return
			current = name
			apply(name)
			self.scheduleDefinitionRefresh()
		},
		collect,
	)
}
