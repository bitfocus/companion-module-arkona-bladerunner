import { InstanceStatus } from '@companion-module/base'
import * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'

/**
 * Retry delay for the *initial* connection only.
 *
 * Once a socket has opened successfully, vscript owns reconnection itself: it re-opens with its own
 * backoff and replays every subscription (`recover_subscriptions`), so an established connection
 * heals without our help - including across a Blade reboot. Adding a second reconnect loop here
 * would fight that one.
 */
const INITIAL_RETRY_MS = 5000

/**
 * Turn a failed write into something the operator can act on.
 *
 * The Blade refuses writes from a session that does not hold the towel currently placed on it, and
 * the raw error only names the holder. Reads are unaffected, so this shows up as "all my variables
 * work but no action does" unless the message says what to do about it.
 */
export function describeWriteError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)

	const towel = /blocked by towel '([^']*)'/.exec(message)
	if (towel) {
		return `blocked by the towel '${towel[1]}' held on this Blade. Set this connection's Towel config field to '${towel[1]}' to work alongside that session, or clear the towel on the device.`
	}

	// An SDI output needs a time source as well as a video source. vapi says so precisely, but not
	// where to look, and the same condition is already visible as the output's `missing_t_src` issue.
	if (/t_src/.test(message)) {
		return `${message} (this output has no time source - see its "time source" variable, and assign a genlock instance such as genlock.instances[0].backend.output on the device)`
	}

	// With no towel held at all the Blade does not reject the write outright - it silently declines
	// it, and vscript surfaces that as its read-back validation failing.
	if (/LHS is .*differs from RHS/.test(message)) {
		return `the Blade did not apply the change (${message}). This usually means no towel is held; set this connection's Towel config field.`
	}

	return message
}

/**
 * Why a control action cannot proceed, or null if it can.
 *
 * Checked before writing so the operator gets the real reason rather than the opaque read-back
 * failure the device produces when an unreserved session tries to change something.
 */
export function writeBlockedReason(towel: string, vm: VAPI.AT1130.Root | null): string | null {
	if (!vm) return 'not connected to the Blade'
	if (!towel) {
		return 'this connection has no Towel configured, and the Blade only accepts control commands from a session holding one. Set the Towel field in this connection config.'
	}
	const held = vm.raw.current_towel?.value ?? ''
	if (held && held !== towel) {
		return `another session holds the towel '${held}'. Set this connection's Towel to '${held}', or clear it on the device.`
	}
	return null
}

/** Owns the socket and its lifecycle. Nothing else in the module touches vscript directly. */
export class BladeConnection {
	readonly #self: ModuleInstance
	#vm: VAPI.AT1130.Root | null = null
	#watchers: VScript.Watcher[] = []
	#retryTimer: NodeJS.Timeout | null = null
	#connectPromise: Promise<void> | null = null
	/** Invalidates an in-flight open when a newer connect or disconnect takes ownership. */
	#connectionGeneration = 0
	/** Set while `disconnect()` is tearing down, so late socket events are ignored. */
	#shuttingDown = false

	constructor(self: ModuleInstance) {
		this.#self = self
	}

	get vm(): VAPI.AT1130.Root | null {
		return this.#vm
	}

	/** Register a watcher so it is torn down with the connection. */
	track(watcher: VScript.Watcher): void {
		this.#watchers.push(watcher)
	}

	async connect(): Promise<void> {
		const pending = this.#openAndDiscover()
		const tracked = pending.finally(() => {
			if (this.#connectPromise === tracked) this.#connectPromise = null
		})
		this.#connectPromise = tracked
		await tracked
	}

	async #openAndDiscover(): Promise<void> {
		this.#clearRetry()
		this.#shuttingDown = false
		const generation = ++this.#connectionGeneration

		const config = this.#self.config
		if (!config.host) {
			this.#self.updateStatus(InstanceStatus.BadConfig, 'No Blade IP configured')
			return
		}

		this.#self.updateStatus(InstanceStatus.Connecting)

		let vm: VAPI.VM.Any
		try {
			vm = await VAPI.VM.open({
				ip: config.host,
				port: config.port,
				protocol: config.protocol,
				towel: config.towel || undefined,
				login: config.username ? { user: config.username, password: this.#self.secrets.password } : null,
				event_handler: (ev) => {
					if (generation === this.#connectionGeneration) this.#onSocketEvent(ev)
				},
			})
		} catch (e: any) {
			if (generation !== this.#connectionGeneration) return
			this.#self.log('error', `Connection to ${config.host} failed: ${e?.message ?? e}`)
			this.#self.updateStatus(InstanceStatus.ConnectionFailure, e?.message ?? 'Connection failed')
			this.#scheduleRetry()
			return
		}

		// VAPI.open cannot be cancelled. A config update may have started another connection while
		// this one was resolving, in which case this VM must never become the action target.
		if (generation !== this.#connectionGeneration) {
			await vm.close().catch(() => undefined)
			return
		}

		if (!(vm instanceof VAPI.AT1130.Root)) {
			// vapi also models the AT1101, whose tree differs enough that our variables would not apply.
			this.#self.log('error', `Unsupported hardware model: ${vm.raw.build_info.hardware_model ?? 'unknown'}`)
			this.#self.updateStatus(InstanceStatus.BadConfig, 'Device is not an AT1130 Blade')
			await vm.close().catch(() => undefined)
			return
		}

		this.#vm = vm
		this.#self.log('info', `Connected to ${config.host} (${vm.raw.build_info.hardware_model ?? 'AT1130'})`)

		if (config.towel) {
			// A towel is a declaration of interest, not a lock - someone else holding one is not a
			// reason to refuse the connection.
			try {
				await vm.raw.place_towel({ override_preexisting_towel: false })
			} catch (e: any) {
				this.#self.log('warn', `Could not place towel: ${e?.message ?? e}`)
			}
		}

		this.#self.updateStatus(InstanceStatus.Ok)

		// Discovery is best-effort: one unsupported component should not cost us the connection, and
		// the socket is already usable by the time we get here.
		try {
			await this.#self.onConnected(vm)
		} catch (e: any) {
			this.#self.log('error', `Device discovery failed: ${e?.message ?? e}`)
		}
	}

	async disconnect(): Promise<void> {
		this.#shuttingDown = true
		this.#connectionGeneration++
		this.#clearRetry()
		const pending = this.#connectPromise

		for (const watcher of this.#watchers) {
			try {
				watcher.unwatch()
			} catch {
				// The socket may already be gone; nothing useful to do.
			}
		}
		this.#watchers = []

		const vm = this.#vm
		this.#vm = null
		if (vm) {
			// close() clears our towel, aborts vscript's reconnect loop and drops all listeners.
			await vm.close().catch((e: any) => this.#self.log('debug', `Error closing socket: ${e?.message ?? e}`))
		}

		// Closing the VM makes discovery reads settle, but wait until their handlers have unwound so
		// they cannot repopulate state after configUpdated clears the previous device's topology.
		await pending?.catch(() => undefined)
	}

	#onSocketEvent(ev: VScript.DataViews.VSocketEvent): void {
		if (this.#shuttingDown) return

		switch (ev.event_type) {
			case 'connection-reopened':
				this.#self.log('info', 'Connection re-established')
				this.#self.updateStatus(InstanceStatus.Ok)
				break

			case 'expected-close':
				// The Blade is rebooting or resetting because it was asked to. vscript will reconnect.
				this.#self.log('info', `Blade is restarting (${ev.reason}); waiting for it to return`)
				this.#self.updateStatus(InstanceStatus.Disconnected, `Blade ${ev.reason}`)
				break

			case 'unexpected-close':
				this.#self.updateStatus(InstanceStatus.ConnectionFailure, 'Connection lost')
				break

			case 'websocket-error':
				this.#self.updateStatus(InstanceStatus.ConnectionFailure, 'Socket error')
				break

			case 'error':
				this.#self.log('error', `Socket error: ${ev.error?.message ?? ev.error}`)
				break

			case 'info':
				this.#self.log('debug', ev.msg)
				break
		}
	}

	#scheduleRetry(): void {
		this.#clearRetry()
		this.#retryTimer = setTimeout(() => {
			this.#retryTimer = null
			void this.connect()
		}, INITIAL_RETRY_MS)
	}

	#clearRetry(): void {
		if (this.#retryTimer) {
			clearTimeout(this.#retryTimer)
			this.#retryTimer = null
		}
	}
}
