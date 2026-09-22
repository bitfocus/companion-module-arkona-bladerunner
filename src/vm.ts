import { InstanceStatus } from '@companion-module/base'
import * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { RestartableTimer } from './timers.js'

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

/** A failed connection attempt, split into what the status shows and what the log says. */
export interface ConnectFailure {
	/** Short enough for the status column in the connections list. */
	status: string
	/** The same failure with what to do about it, for the log line. */
	detail: string
}

/**
 * Turn a failed connection attempt into something the operator can act on.
 *
 * What lands here is whatever the layer that gave up produced: a node socket error, one of
 * vscript's handshake errors, a plain string from its build_info download, or - when the module
 * itself is at fault - a TypeError. None of them mention the Blade or say what to change, and the
 * raw text of the last kind ("S is not a constructor") is meaningless to an operator.
 */
export function describeConnectError(error: unknown, target: string): ConnectFailure {
	const message = error instanceof Error ? error.message : String(error)
	const code = error instanceof Error && 'code' in error ? String(error.code) : ''

	switch (code) {
		case 'ECONNREFUSED':
			return {
				status: 'Connection refused',
				detail: `nothing is listening on ${target}. Check the Blade is powered on, and that the Port and Protocol in this connection's config match its web interface.`,
			}
		case 'EHOSTUNREACH':
		case 'EHOSTDOWN':
		case 'ENETUNREACH':
			return {
				status: 'Host unreachable',
				detail: `there is no network route to ${target}. Check the Blade IP, and that this machine is on a network that can reach it.`,
			}
		case 'ETIMEDOUT':
			return {
				status: 'No response',
				detail: `${target} accepted no connection before the attempt timed out. Check the Blade IP and that nothing between the two machines is blocking the port.`,
			}
		case 'ENOTFOUND':
		case 'EAI_AGAIN':
			return {
				status: 'Unknown host',
				detail: `the address ${target} could not be resolved. Enter the Blade's IP address in this connection's config.`,
			}
		case 'ECONNRESET':
			return {
				status: 'Connection reset',
				detail: `${target} closed the connection during the handshake. If the Blade uses https, set Protocol to wss.`,
			}
	}

	// vscript rejects an unauthorised handshake with its own advice, which names a VM.open parameter
	// this module sets from the config fields rather than the fields themselves.
	if (/password-protected|Unauthorized/i.test(message)) {
		return {
			status: 'Login required',
			detail: `${target} is password protected. Fill in the Username and Password fields in this connection's config.`,
		}
	}

	// A rejected certificate names itself in the message, in the error code ('CERT_HAS_EXPIRED',
	// 'DEPTH_ZERO_SELF_SIGNED_CERT', …) or in both, depending on where node gave up.
	if (/certificate|self.signed|_CERT|CERT_|\bSSL\b|\bTLS\b/i.test(`${code} ${message}`)) {
		return {
			status: 'Certificate rejected',
			detail: `the certificate ${target} presented was not accepted (${message}). Blades ship with a self-signed certificate, so set Protocol to ws unless the Blade has one your system trusts.`,
		}
	}

	if (/^Timeout after/.test(message)) {
		return {
			status: 'No response',
			detail: `${target} did not answer in time (${message}). Check the Blade IP, and that Protocol matches what its web interface serves.`,
		}
	}

	// Something is listening and speaks HTTP, but did not complete a Blade websocket handshake.
	if (/unexpected response|webserver_buildinfo|unexpectedly closed/i.test(message)) {
		return {
			status: 'Not a Blade',
			detail: `${target} answered, but not as a BLADE//runner web interface (${message}). Check the IP, Port and Protocol point at a Blade.`,
		}
	}

	// The websocket is up but the build_info fetch that follows it uses plain http(s) on the same
	// port, so this is usually a proxy or firewall that allows one and not the other.
	if (/^Unable to download/.test(message)) {
		return {
			status: 'Incomplete handshake',
			detail: `the websocket to ${target} opened but its build information could not be read (${message}). Check that http access to the Blade is not blocked.`,
		}
	}

	if (error instanceof TypeError) {
		return {
			status: 'Module error',
			detail: `the module hit an internal error while connecting to ${target} (${message}). This is a bug in the module rather than a problem with the Blade - please report it.`,
		}
	}

	return { status: 'Connection failed', detail: `could not connect to ${target} (${message}).` }
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
	readonly #open: typeof VAPI.VM.open
	#vm: VAPI.AT1130.Root | null = null
	#watchers: VScript.Watcher[] = []
	readonly #retryTimer = new RestartableTimer()
	#connectPromise: Promise<void> | null = null
	/**
	 * Invalidates an in-flight open when a newer connect or disconnect takes ownership - including a
	 * disconnect's own teardown, so a socket event arriving after `disconnect()` starts is ignored too.
	 */
	#connectionGeneration = 0
	/** The last problem written to the log, so a retry loop reports a change rather than a tick. */
	#reportedProblem: string | null = null

	constructor(self: ModuleInstance, open: typeof VAPI.VM.open = VAPI.VM.open) {
		this.#self = self
		this.#open = open
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
		this.#retryTimer.cancel()
		const generation = ++this.#connectionGeneration

		const config = this.#self.config
		if (!config.host) {
			this.#self.updateStatus(InstanceStatus.BadConfig, 'No Blade IP configured')
			return
		}

		this.#self.updateStatus(InstanceStatus.Connecting)

		let vm: VAPI.VM.Any
		try {
			vm = await this.#open({
				ip: config.host,
				port: config.port,
				protocol: config.protocol,
				towel: config.towel || undefined,
				login: config.username ? { user: config.username, password: this.#self.secrets.password } : null,
				event_handler: (ev) => {
					if (generation === this.#connectionGeneration) this.#onSocketEvent(ev)
				},
			})
		} catch (e: unknown) {
			if (generation !== this.#connectionGeneration) return
			const failure = describeConnectError(e, `${config.host}:${config.port}`)
			this.#reportProblem(
				'error',
				`Connection failed: ${failure.detail} Retrying every ${INITIAL_RETRY_MS / 1000} seconds.`,
			)
			this.#self.updateStatus(InstanceStatus.ConnectionFailure, failure.status)
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
		this.#reportedProblem = null
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
		this.#connectionGeneration++
		this.#reportedProblem = null
		this.#retryTimer.cancel()
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
		switch (ev.event_type) {
			case 'connection-reopened':
				this.#reportedProblem = null
				this.#self.log('info', 'Connection re-established')
				this.#self.updateStatus(InstanceStatus.Ok)
				break

			case 'expected-close':
				// The Blade is rebooting or resetting because it was asked to. vscript will reconnect.
				this.#self.log('info', `Blade is restarting (${ev.reason}); waiting for it to return`)
				this.#self.updateStatus(InstanceStatus.Disconnected, `Blade ${ev.reason}`)
				break

			case 'unexpected-close':
				// vscript reconnects on its own from here, so this is a report rather than a dead end.
				this.#reportProblem('warn', 'Lost contact with the Blade; reconnecting')
				this.#self.updateStatus(InstanceStatus.ConnectionFailure, 'Reconnecting')
				break

			case 'websocket-error':
				this.#reportProblem('warn', 'Network error on the connection to the Blade; reconnecting')
				this.#self.updateStatus(InstanceStatus.ConnectionFailure, 'Reconnecting')
				break

			case 'error':
				this.#reportProblem('error', `Socket error: ${ev.error?.message ?? ev.error}`)
				break

			case 'info':
				this.#self.log('debug', ev.msg)
				break
		}
	}

	/**
	 * Log a problem the first time it is seen, and again only once it reads differently.
	 *
	 * Both reconnect loops - ours for the initial open, vscript's for an established socket - keep
	 * producing the same failure for as long as the Blade is away, which is an outage worth one log
	 * entry rather than one every few seconds. Connecting clears the memory, so the next outage is
	 * reported again.
	 */
	#reportProblem(level: 'warn' | 'error', message: string): void {
		if (this.#reportedProblem === message) return
		this.#reportedProblem = message
		this.#self.log(level, message)
	}

	#scheduleRetry(): void {
		this.#retryTimer.restart(INITIAL_RETRY_MS, () => void this.connect())
	}
}
