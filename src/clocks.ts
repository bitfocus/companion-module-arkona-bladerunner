import type { CompanionVariableDefinition, DropdownChoice } from '@companion-module/base'
import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { watchAll, watchKeyword } from './watch.js'

/** Clearing a time source is a real choice, distinct from "not configured yet". */
export const NO_TIME_SOURCE = ''

export interface GenlockState {
	index: number
	name: string
	timeSourcePath: string | null
	/** Null offset means the instance is not driving anything - genlock 2 is idle out of the box. */
	offsetNs: number | null
}

export interface PtpState {
	state: string | null
	mode: string | null
	timeSourcePath: string | null
	offsetNs: number | null
	driftPpm: number | null
	clockSpeedPpm: number | null
	cycleDetected: boolean | null
}

/** PTP is locked only once it is both calibrated and locked; "Calibrated" alone is still settling. */
export function isPtpLocked(state: PtpState): boolean {
	return state.state === 'CalibratedAndLocked'
}

export class ClockState {
	readonly genlocks = new Map<number, GenlockState>()
	ptp: PtpState = {
		state: null,
		mode: null,
		timeSourcePath: null,
		offsetNs: null,
		driftPpm: null,
		clockSpeedPpm: null,
		cycleDetected: null,
	}

	/**
	 * What an SDI output's `t_src` can be pointed at.
	 *
	 * The PTP clock and each genlock instance are all `Time::Data::Source` subtrees, and the value
	 * written is the keyword path, so the path is used as the stable choice ID.
	 */
	timeSourceChoices(): DropdownChoice[] {
		return [
			{ id: NO_TIME_SOURCE, label: 'None' },
			{ id: PTP_CLOCK_OUTPUT, label: 'PTP Clock' },
			...[...this.genlocks.values()].map((g) => ({ id: genlockOutputPath(g.index), label: g.name })),
		]
	}

	clear(): void {
		this.genlocks.clear()
		this.ptp = {
			state: null,
			mode: null,
			timeSourcePath: null,
			offsetNs: null,
			driftPpm: null,
			clockSpeedPpm: null,
			cycleDetected: null,
		}
	}
}

export const PTP_CLOCK_OUTPUT = 'p_t_p_clock.output'

export function genlockOutputPath(index: number): string {
	return `genlock.instances[${index}].backend.output`
}

/** A `Duration` where one is expected, a bare number where the device sends a rate. */
function toNs(value: unknown): number | null {
	if (value && typeof (value as { ns?: unknown }).ns === 'function') return (value as { ns: () => number }).ns()
	return typeof value === 'number' ? value : null
}

/** Relative clock speed and drift both arrive as fractions; parts-per-million is how they are read. */
export function toPpm(value: number | null | undefined): number | null {
	return typeof value === 'number' ? Number((value * 1e6).toFixed(4)) : null
}

export function ClockVariableDefinitions(state: ClockState): CompanionVariableDefinition[] {
	return [
		{ variableId: 'ptp_state', name: 'PTP - Clock State' },
		{ variableId: 'ptp_locked', name: 'PTP - Locked' },
		{ variableId: 'ptp_mode', name: 'PTP - Clock Mode' },
		{ variableId: 'ptp_time_source', name: 'PTP - Input Time Source' },
		{ variableId: 'ptp_offset_ns', name: 'PTP - Offset To Master (ns)' },
		{ variableId: 'ptp_drift_ppm', name: 'PTP - Master Drift (ppm)' },
		{ variableId: 'ptp_clock_speed_ppm', name: 'PTP - Local Clock Speed (ppm)' },
		{ variableId: 'ptp_cycle_detected', name: 'PTP - Timing Cycle Detected' },

		...[...state.genlocks.keys()].flatMap((g) => [
			{ variableId: `genlock_${g}_name`, name: `Genlock ${g} - Name` },
			{ variableId: `genlock_${g}_time_source`, name: `Genlock ${g} - Time Source` },
			{ variableId: `genlock_${g}_offset_ns`, name: `Genlock ${g} - Offset (ns)` },
			{ variableId: `genlock_${g}_in_use`, name: `Genlock ${g} - In Use` },
		]),

		{ variableId: 'identify', name: 'System - Identify Active' },
		{ variableId: 'led_brightness', name: 'System - Front Panel LED Brightness' },
	]
}

/**
 * Subscribe the PTP clock, the genlock instances and the front panel identify state.
 *
 * Genlock instances are a fixed-size array rather than an allocated table, so every instance is
 * watched; an idle one simply reports a null time source and offset.
 */
export async function subscribeClocks(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
	const batcher = self.variables
	const state = self.clocks
	const collect = (w: VScript.Watcher): void => self.connection.track(w)
	// Independent round trips, registered concurrently - see watchAll.
	const pending: Array<Promise<void>> = []

	const ptp = vm.p_t_p_clock
	pending.push(
		watchKeyword(
			self,
			'ptp.state',
			ptp.state,
			(v) => {
				state.ptp.state = v
				batcher.set('ptp_state', v ?? '')
				batcher.set('ptp_locked', String(isPtpLocked(state.ptp)))
				self.checkFeedbacks('ptp_locked')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'ptp.mode',
			ptp.mode,
			(v) => {
				state.ptp.mode = v
				batcher.set('ptp_mode', v ?? '')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'ptp.t_src',
			ptp.t_src.status,
			(v) => {
				const path = v ? String(v.raw.kwl) : null
				state.ptp.timeSourcePath = path
				batcher.set('ptp_time_source', path ?? '')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'ptp.clock_speed',
			ptp.relative_clock_speed,
			(v) => {
				state.ptp.clockSpeedPpm = toPpm(v)
				batcher.set('ptp_clock_speed_ppm', state.ptp.clockSpeedPpm ?? '')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'ptp.offset',
			ptp.output.offset,
			(v: any) => {
				state.ptp.offsetNs = toNs(v?.value)
				batcher.set('ptp_offset_ns', state.ptp.offsetNs ?? '')
				self.checkFeedbacks('ptp_locked')
			},
			collect,
		),
	)

	// Drift arrives as a bare rate rather than a Duration, unlike offset.
	pending.push(
		watchKeyword(
			self,
			'ptp.drift',
			ptp.output.drift,
			(v: any) => {
				state.ptp.driftPpm = toPpm(typeof v?.value === 'number' ? v.value : null)
				batcher.set('ptp_drift_ppm', state.ptp.driftPpm ?? '')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'ptp.issues',
			ptp.output.issues,
			(v: any) => {
				state.ptp.cycleDetected = v?.cycle_detected ?? null
				batcher.set('ptp_cycle_detected', v?.cycle_detected === undefined ? '' : String(v.cycle_detected))
			},
			collect,
		),
	)

	const genlocks = vm.genlock?.instances
	for (let g = 0; g < (genlocks?.size ?? 0); g++) {
		const instance = genlocks!.row(g)
		state.genlocks.set(g, { index: g, name: `Genlock #${g}`, timeSourcePath: null, offsetNs: null })
		const entry = state.genlocks.get(g)!

		pending.push(
			watchKeyword(
				self,
				`genlock[${g}].brief`,
				instance.brief,
				(v) => {
					entry.name = v
					batcher.set(`genlock_${g}_name`, v)
				},
				collect,
			),
		)

		pending.push(
			watchKeyword(
				self,
				`genlock[${g}].t_src`,
				instance.t_src.status,
				(v) => {
					const path = v ? String(v.raw.kwl) : null
					entry.timeSourcePath = path
					batcher.set(`genlock_${g}_time_source`, path ?? '')
					batcher.set(`genlock_${g}_in_use`, String(path !== null))
					self.checkFeedbacks('genlock_in_use')
				},
				collect,
			),
		)

		pending.push(
			watchKeyword(
				self,
				`genlock[${g}].offset`,
				instance.backend.output.offset,
				(v: any) => {
					entry.offsetNs = toNs(v?.value)
					batcher.set(`genlock_${g}_offset_ns`, entry.offsetNs ?? '')
				},
				collect,
			),
		)
	}

	pending.push(
		watchKeyword(
			self,
			'system.identify',
			vm.system.frontpanel_blink_blue,
			(v) => {
				self.identifyActive = v
				batcher.set('identify', String(v))
				self.checkFeedbacks('identify')
			},
			collect,
		),
	)

	pending.push(
		watchKeyword(
			self,
			'system.led_brightness',
			vm.system.frontpanel_led_brightness,
			(v) => {
				batcher.set('led_brightness', v)
			},
			collect,
		),
	)

	await watchAll(pending)
	batcher.flush()
}
