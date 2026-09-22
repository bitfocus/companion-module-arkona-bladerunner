import type { CompanionVariableDefinition, DropdownChoice } from '@companion-module/base'
import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { activeIssues, formatIssueLabels, publishIssues, reportIssues } from './issues.js'
import {
	activeSourceVariable,
	buildRegistry,
	destinationId,
	flowRegistryValues,
	isBreakaway,
	sourceIdForPath,
	type FlowLevel,
} from './routing.js'
import { RestartableTimer } from './timers.js'
import { watchAll, watchKeyword } from './watch.js'

/** Rediscovery is debounced so flipping several BNCs in a row costs one pass, not one each. */
const REDISCOVER_DEBOUNCE_MS = 750

/** What a BNC is physically wired to support, from `info.bnc[n].direction`. */
export type BncCapability = 'ceDisable' | 'ceIn' | 'ceOut' | 'ceInOut'

/** What a BNC is currently configured as, from `configuration[n].direction`. */
export type BncDirection = 'Input' | 'Output'

export interface BncState {
	index: number
	capability: BncCapability
	direction: BncDirection | null
}

/**
 * Which directions a port can actually be set to.
 *
 * Not every chassis has reversible BNCs - an 18x2 IO board has ports wired one way only - so the
 * capability decides what may be offered, never the current direction.
 */
export function allowedDirections(capability: BncCapability): BncDirection[] {
	switch (capability) {
		case 'ceInOut':
			return ['Input', 'Output']
		case 'ceIn':
			return ['Input']
		case 'ceOut':
			return ['Output']
		default:
			return []
	}
}

export function canSetDirection(bnc: BncState | undefined, direction: BncDirection): boolean {
	return !!bnc && allowedDirections(bnc.capability).includes(direction)
}

export interface SdiInputState {
	index: number
	name: string
	lockStatus: string | null
	standard: string | null
	black: boolean | null
	frozen: boolean | null
}

export interface SdiOutputState {
	index: number
	standard: string | null
	timeSourcePath: string | null
	videoSourcePath: string | null
	videoSourceName: string | null
	audioSourcePath: string | null
	audioSourceName: string | null
	issues: string[]
	resyncCount: number
}

/** `LockedToData` means a real signal; `LockedToRef` means the port fell back to the reference. */
export function isLocked(input: SdiInputState | undefined): boolean {
	return input?.lockStatus === 'LockedToData'
}

/**
 * Current state of the physical SDI ports, kept up to date by the subscriptions in `IoManager`.
 *
 * Feedbacks read from here rather than the device, so evaluating one is synchronous.
 */
export class IoState {
	readonly inputs = new Map<number, SdiInputState>()
	readonly outputs = new Map<number, SdiOutputState>()
	readonly bncs = new Map<number, BncState>()

	inputChoices(): DropdownChoice[] {
		return [...this.inputs.values()].map((i) => ({ id: i.index, label: `${i.index}: ${i.name}` }))
	}

	outputChoices(): DropdownChoice[] {
		return [...this.outputs.values()].map((o) => ({ id: o.index, label: `SDI Output ${o.index}` }))
	}

	/** Only ports that can actually be reconfigured, so the action cannot offer an impossible change. */
	reversibleBncChoices(): DropdownChoice[] {
		return [...this.bncs.values()]
			.filter((b) => allowedDirections(b.capability).length > 1)
			.map((b) => ({ id: b.index, label: `SDI ${b.index} (${b.direction ?? 'unknown'})` }))
	}

	bncChoices(): DropdownChoice[] {
		return [...this.bncs.values()]
			.filter((b) => allowedDirections(b.capability).length > 0)
			.map((b) => ({ id: b.index, label: `SDI ${b.index}` }))
	}

	clear(): void {
		this.inputs.clear()
		this.outputs.clear()
	}
}

export function IoVariableDefinitions(state: IoState): CompanionVariableDefinition[] {
	return [
		{ variableId: 'sdi_input_count', name: 'SDI Inputs Count' },
		{ variableId: 'sdi_output_count', name: 'SDI Outputs Count' },
		{ variableId: 'sdi_inputs_locked', name: 'SDI Inputs with Signal' },

		...[...state.bncs.keys()].map((i) => ({
			variableId: `sdi_${i}_configuration`,
			name: `SDI ${i} - I/O Configuration`,
		})),

		...[...state.inputs.keys()].flatMap((i) => [
			{ variableId: `sdi_in_${i}_name`, name: `SDI Input ${i} - Name` },
			{ variableId: `sdi_in_${i}_locked`, name: `SDI Input ${i} - Signal Present` },
			{ variableId: `sdi_in_${i}_lock_status`, name: `SDI Input ${i} - Lock Status` },
			{ variableId: `sdi_in_${i}_standard`, name: `SDI Input ${i} - Video Standard` },
			{ variableId: `sdi_in_${i}_black`, name: `SDI Input ${i} - Is Black` },
			{ variableId: `sdi_in_${i}_frozen`, name: `SDI Input ${i} - Appears Frozen` },
		]),

		...[...state.outputs.keys()].flatMap((i) => [
			{ variableId: `sdi_out_${i}_standard`, name: `SDI Output ${i} - Video Standard` },
			{ variableId: `sdi_out_${i}_source`, name: `SDI Output ${i} - Routed Source` },
			{ variableId: `sdi_out_${i}_source_path`, name: `SDI Output ${i} - Routed Source Path` },
			{ variableId: `sdi_out_${i}_issues`, name: `SDI Output ${i} - Issues` },
			{ variableId: `sdi_out_${i}_resync_count`, name: `SDI Output ${i} - Resync Count` },
			{ variableId: `sdi_out_${i}_time_source`, name: `SDI Output ${i} - Time Source` },
		]),
	]
}

/**
 * `black` / `frozen` are `null | boolean` on the essence. Null means the detector has not
 * classified the picture yet (typical with no lock), which is not the same as false.
 */
export function formatBool(value: boolean | null | undefined): string {
	if (value === null || value === undefined) return 'unknown'
	return String(value)
}

/**
 * `standard` is `null | Standard`. Null means no resolved format yet (unlocked, or the output has
 * no source). Device names like `HD1080p59_94` are rewritten for display; state still keeps the enum.
 */
export function formatStandard(value: string | null | undefined): string {
	if (value === null || value === undefined || value === '') return 'unknown'
	if (value === 'PAL' || value === 'NTSC') return value

	let label = value.startsWith('HD') ? value.slice(2) : value
	label = label.replace(/_DCI$/, ' DCI')
	label = label.replace(/sF/, 'PsF')
	label = label.replace(/_(\d+)$/, '.$1')
	return label
}

/**
 * Owns discovery of and subscription to the physical SDI ports.
 *
 * The port tables are not fixed: each BNC can be configured as an input or an output, so the
 * indices are BNC numbers rather than a 0-based sequence, either table can be empty, and the whole
 * layout can change while we are connected. The BNC direction keywords are therefore watched too,
 * and a change re-runs discovery.
 */
export class IoManager {
	readonly state = new IoState()
	#portWatchers: VScript.Watcher[] = []
	#directionWatchers: VScript.Watcher[] = []
	/** Last seen direction per BNC, so an initial read is not mistaken for a change. */
	#directions = new Map<number, string>()
	readonly #rediscoverTimer = new RestartableTimer()

	/** Full setup for a fresh connection: watch BNC directions, then discover and subscribe. */
	async start(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
		const iom = vm.i_o_module
		if (!iom) {
			self.log('info', 'This Blade has no IO module; skipping SDI status')
			return
		}

		this.#disposeDirectionWatchers()
		this.state.bncs.clear()

		let directions: number[] = []
		try {
			directions = await iom.configuration.allocated_indices()
		} catch (e: any) {
			self.log('warn', `Could not read BNC configuration: ${e?.message ?? e}`)
		}

		// `info.bnc` is a fixed-size array padded well beyond the real ports, so it is read only for
		// the indices the configuration table says exist.
		for (const i of directions) {
			let capability: BncCapability = 'ceDisable'
			try {
				capability = await iom.info.bnc.row(i).direction.read()
			} catch (e: any) {
				self.log('debug', `Could not read BNC ${i} capability: ${e?.message ?? e}`)
			}
			this.state.bncs.set(i, { index: i, capability, direction: null })
		}

		for (const i of directions) {
			await watchKeyword(
				self,
				`configuration[${i}].direction`,
				iom.configuration.row(i).direction,
				(direction) => {
					const bnc = this.state.bncs.get(i)
					if (bnc) bnc.direction = direction
					self.variables.set(`sdi_${i}_configuration`, direction)
					self.checkFeedbacks('sdi_configuration')

					// `ensure_initial_read` delivers the current value up front, which must not be
					// mistaken for a change - otherwise every connect triggers a pointless rediscovery.
					const previous = this.#directions.get(i)
					this.#directions.set(i, direction)
					if (previous !== undefined && previous !== direction) {
						self.log('info', `SDI ${i} changed configuration to ${direction}`)
						this.#scheduleRediscover(self, vm)
					}
				},
				(w) => this.#directionWatchers.push(w),
			)
		}

		await this.#discoverAndSubscribe(self, vm)
	}

	/** A BNC changed direction, so the input/output tables have been reallocated underneath us. */
	#scheduleRediscover(self: ModuleInstance, vm: VAPI.AT1130.Root): void {
		this.#rediscoverTimer.restart(REDISCOVER_DEBOUNCE_MS, () => {
			void (async () => {
				try {
					await this.#discoverAndSubscribe(self, vm)
				} catch (e: any) {
					self.log('warn', `Rediscovery failed: ${e?.message ?? e}`)
				}
			})()
		})
	}

	async #discoverAndSubscribe(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
		const iom = vm.i_o_module
		if (!iom) return

		this.#disposePortWatchers()
		this.state.clear()

		const [inputs, outputs] = await Promise.all([iom.input.allocated_indices(), iom.output.allocated_indices()])
		self.issues.retire('sdi_out_', new Set(outputs.map((i) => `sdi_out_${i}`)))
		publishIssues(self)
		self.checkFeedbacks('has_issues')
		for (const i of inputs) {
			this.state.inputs.set(i, {
				index: i,
				name: `SDI Input ${i}`,
				lockStatus: null,
				standard: null,
				black: null,
				frozen: null,
			})
		}
		for (const i of outputs) {
			this.state.outputs.set(i, {
				index: i,
				standard: null,
				timeSourcePath: null,
				videoSourcePath: null,
				videoSourceName: null,
				audioSourcePath: null,
				audioSourceName: null,
				issues: [],
				resyncCount: 0,
			})
		}
		self.log(
			'debug',
			`SDI I/O Reported: ${inputs.length} input(s) ${JSON.stringify(inputs)}, ${outputs.length} output(s) ${JSON.stringify(outputs)}`,
		)

		// Definitions depend on which ports exist, so they are rebuilt on every discovery.
		self.rebuildDefinitions()

		const batcher = self.variables
		batcher.set('sdi_input_count', inputs.length)
		batcher.set('sdi_output_count', outputs.length)
		for (const [id, value] of Object.entries(flowRegistryValues(buildRegistry(self.flowState)))) {
			batcher.set(id, value)
		}

		const collect = (w: VScript.Watcher): void => {
			this.#portWatchers.push(w)
		}

		// Ports are set up concurrently. Registering a watch is cheap, but the reads interleaved with
		// them are not, so overlapping the ports still helps.
		const perPort: Array<Promise<void>> = []

		for (const i of inputs) {
			const port = iom.input.row(i)
			const state = this.state.inputs.get(i)!

			perPort.push(
				(async () => {
					await watchKeyword(
						self,
						`in[${i}].brief`,
						port.sdi.output.video.brief,
						(v) => {
							// The brief follows whatever the port is named on the device, so a rename there has
							// to reach the source label and the choices as well as this variable.
							const changed = state.name !== v
							state.name = v
							batcher.set(`sdi_in_${i}_name`, v)
							if (changed) self.scheduleDefinitionRefresh()
						},
						collect,
					)

					await watchKeyword(
						self,
						`in[${i}].locked`,
						port.sdi.hw_status.phy_rx_locked_status,
						(v) => {
							state.lockStatus = v
							batcher.set(`sdi_in_${i}_lock_status`, v ?? '')
							batcher.set(`sdi_in_${i}_locked`, String(isLocked(state)))
							this.#publishLockedCount(batcher)
							self.checkFeedbacks('sdi_input_locked')
						},
						collect,
					)

					await watchKeyword(
						self,
						`in[${i}].standard`,
						port.sdi.hw_status.standard,
						(v) => {
							state.standard = v
							batcher.set(`sdi_in_${i}_standard`, formatStandard(v))
							self.checkFeedbacks('sdi_input_standard')
						},
						collect,
					)

					await watchKeyword(
						self,
						`in[${i}].black`,
						port.sdi.output.video.black,
						(v) => {
							state.black = v
							batcher.set(`sdi_in_${i}_black`, formatBool(v))
							self.checkFeedbacks('sdi_input_black')
						},
						collect,
					)

					await watchKeyword(
						self,
						`in[${i}].frozen`,
						port.sdi.output.video.frozen,
						(v) => {
							state.frozen = v
							batcher.set(`sdi_in_${i}_frozen`, formatBool(v))
							self.checkFeedbacks('sdi_input_frozen')
						},
						collect,
					)
				})(),
			)
		}

		for (const i of outputs) {
			const port = iom.output.row(i)
			const state = this.state.outputs.get(i)!

			perPort.push(
				(async () => {
					await watchKeyword(
						self,
						`out[${i}].standard`,
						port.sdi.standard,
						(v) => {
							state.standard = v
							batcher.set(`sdi_out_${i}_standard`, formatStandard(v))
							self.checkFeedbacks('sdi_output_active')
						},
						collect,
					)

					await watchKeyword(
						self,
						`out[${i}].issues`,
						port.sdi.issues,
						(v) => {
							state.issues = activeIssues(v)
							batcher.set(`sdi_out_${i}_issues`, formatIssueLabels(state.issues))
							self.checkFeedbacks('sdi_output_issues')
							// Also reported through the device-wide layer, so one feedback can watch everything.
							reportIssues(self, `sdi_out_${i}`, `SDI Output ${i}`, state.issues)
						},
						collect,
					)

					await watchKeyword(
						self,
						`out[${i}].resync`,
						port.resync_counter,
						(v) => {
							state.resyncCount = v
							batcher.set(`sdi_out_${i}_resync_count`, v)
						},
						collect,
					)

					// Surfaced because a null time source is exactly what blocks routing, and that is otherwise
					// only discoverable by trying to route and reading the error.
					await watchKeyword(
						self,
						`out[${i}].t_src`,
						port.sdi.t_src.status,
						(v) => {
							const path = v ? String(v.raw.kwl) : null
							state.timeSourcePath = path
							batcher.set(`sdi_out_${i}_time_source`, path ?? '')
						},
						collect,
					)

					// The routed source arrives as a TimedSource; its path is available synchronously but a
					// friendly name needs a second read, so the path lands first and the name follows.
					await watchKeyword(
						self,
						`out[${i}].v_src`,
						port.sdi.v_src.status,
						(v) => this.#publishRoutedSource(self, state, 'video', v?.source ?? null),
						collect,
					)

					// Audio is routed independently of video - `a_src` hangs off the output itself, not off
					// `.sdi` - so the two levels are watched separately and can disagree (a breakaway).
					await watchKeyword(
						self,
						`out[${i}].a_src`,
						port.a_src.status,
						(v) => this.#publishRoutedSource(self, state, 'audio', v?.source ?? null),
						collect,
					)
				})(),
			)
		}

		await watchAll(perPort)

		this.#publishLockedCount(batcher)
		batcher.flush()
		self.checkFeedbacks(
			'sdi_input_locked',
			'sdi_input_black',
			'sdi_input_frozen',
			'sdi_input_standard',
			'sdi_output_issues',
			'sdi_output_active',
		)
	}

	/**
	 * Publish one level's routed source for an output.
	 *
	 * The path is available synchronously; a friendly name needs a second read, so the ID lands
	 * first and the label follows.
	 */
	#publishRoutedSource(
		self: ModuleInstance,
		state: SdiOutputState,
		level: FlowLevel,
		source: { raw: { kwl: unknown }; brief: { read: () => Promise<string> } } | null,
	): void {
		const batcher = self.variables
		const i = state.index
		const destination = destinationId(i)
		const path = source ? String(source.raw.kwl) : null
		const variable = activeSourceVariable(destination, level)

		if (level === 'video') {
			state.videoSourcePath = path
			// Kept for the SDI status view, which predates levels and means video.
			batcher.set(`sdi_out_${i}_source_path`, path ?? '')
		} else {
			state.audioSourcePath = path
		}

		// The router contract: this value must be exactly what the route action would accept, so a
		// source outside the current SDI scope publishes empty, not a guess.
		batcher.set(variable, sourceIdForPath(path, level, self.processors) ?? '')
		batcher.set(
			`dest_${destination}_breakaway`,
			String(isBreakaway(buildRegistry(self.flowState).destinations.get(destination))),
		)
		self.checkFeedbacks('sdi_output_active', 'flow_routed', 'flow_breakaway')

		const setLabel = (label: string): void => {
			if (level === 'video') {
				state.videoSourceName = label || null
				batcher.set(`sdi_out_${i}_source`, label)
			} else {
				state.audioSourceName = label || null
			}
			batcher.set(`${variable}_label`, label)
		}

		if (!source) {
			setLabel('')
			return
		}
		void source.brief
			.read()
			.then((brief) => setLabel(brief))
			.catch(() => setLabel(path ?? ''))
	}

	#publishLockedCount(batcher: ModuleInstance['variables']): void {
		const locked = [...this.state.inputs.values()].filter((i) => isLocked(i)).length
		batcher.set('sdi_inputs_locked', locked)
	}

	#disposeDirectionWatchers(): void {
		for (const w of this.#directionWatchers) {
			try {
				w.unwatch()
			} catch {
				// The socket may already be gone.
			}
		}
		this.#directionWatchers = []
		this.#directions.clear()
	}

	#disposePortWatchers(): void {
		for (const w of this.#portWatchers) {
			try {
				w.unwatch()
			} catch {
				// The socket may already be gone.
			}
		}
		this.#portWatchers = []
	}

	dispose(): void {
		this.#rediscoverTimer.cancel()
		this.#disposePortWatchers()
		this.#disposeDirectionWatchers()
		this.state.clear()
		this.state.bncs.clear()
	}
}
