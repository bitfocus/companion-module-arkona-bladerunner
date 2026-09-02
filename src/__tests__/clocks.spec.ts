import { describe, expect, it } from 'vitest'
import {
	ClockState,
	ClockVariableDefinitions,
	genlockOutputPath,
	isPtpLocked,
	NO_TIME_SOURCE,
	PTP_CLOCK_OUTPUT,
	toPpm,
	type PtpState,
} from '../clocks.js'

const ptp = (over: Partial<PtpState> = {}): PtpState => ({
	state: null,
	mode: null,
	timeSourcePath: null,
	offsetNs: null,
	driftPpm: null,
	clockSpeedPpm: null,
	cycleDetected: null,
	...over,
})

describe('isPtpLocked', () => {
	it('requires calibrated AND locked', () => {
		expect(isPtpLocked(ptp({ state: 'CalibratedAndLocked' }))).toBe(true)
	})

	// "Calibrated" alone is still settling, and FreeRun means no external reference at all.
	it('does not treat a still-settling clock as locked', () => {
		expect(isPtpLocked(ptp({ state: 'Calibrated' }))).toBe(false)
		expect(isPtpLocked(ptp({ state: 'Uncalibrated' }))).toBe(false)
		expect(isPtpLocked(ptp({ state: 'FreeRun' }))).toBe(false)
		expect(isPtpLocked(ptp())).toBe(false)
	})
})

describe('toPpm', () => {
	// The device reports a fraction; 4.85e-7 is 0.485 ppm, which is the readable form.
	it('converts a fraction to parts per million', () => {
		expect(toPpm(4.850488395760456e-7)).toBe(0.485)
		expect(toPpm(0)).toBe(0)
		expect(toPpm(-1e-6)).toBe(-1)
	})

	it('passes through a missing reading rather than reporting zero', () => {
		expect(toPpm(null)).toBeNull()
		expect(toPpm(undefined)).toBeNull()
	})
})

describe('ClockState.clear', () => {
	it('removes all device-derived clock state', () => {
		const state = new ClockState()
		state.genlocks.set(0, { index: 0, name: 'Old Genlock', timeSourcePath: 'old', offsetNs: 12 })
		state.ptp.state = 'CalibratedAndLocked'
		state.ptp.offsetNs = 42

		state.clear()

		expect(state.genlocks.size).toBe(0)
		expect(state.ptp.state).toBeNull()
		expect(state.ptp.offsetNs).toBeNull()
	})
})

describe('time source choices', () => {
	const state = new ClockState()
	state.genlocks.set(0, { index: 0, name: 'Genlock #0', timeSourcePath: PTP_CLOCK_OUTPUT, offsetNs: 0 })
	state.genlocks.set(1, { index: 1, name: 'Genlock #1', timeSourcePath: null, offsetNs: null })

	it('offers the PTP clock, every genlock, and a way to clear', () => {
		expect(state.timeSourceChoices().map((c) => c.id)).toEqual([
			NO_TIME_SOURCE,
			PTP_CLOCK_OUTPUT,
			genlockOutputPath(0),
			genlockOutputPath(1),
		])
	})

	// The choice ID is written straight to t_src, so it must be the device's own keyword path.
	it('uses the keyword path as the choice ID', () => {
		expect(genlockOutputPath(2)).toBe('genlock.instances[2].backend.output')
	})

	// An idle genlock is still selectable - assigning it is how you bring it into use.
	it('offers a genlock that is not currently in use', () => {
		expect(state.timeSourceChoices().map((c) => c.id)).toContain(genlockOutputPath(1))
	})
})

describe('ClockVariableDefinitions', () => {
	it('defines the PTP metrics regardless of genlock count', () => {
		const ids = ClockVariableDefinitions(new ClockState()).map((d) => d.variableId)
		expect(ids).toContain('ptp_offset_ns')
		expect(ids).toContain('ptp_drift_ppm')
		expect(ids).toContain('ptp_clock_speed_ppm')
		expect(ids).toContain('identify')
		expect(ids).not.toContain('genlock_0_offset_ns')
	})

	it('adds a group per genlock instance', () => {
		const state = new ClockState()
		state.genlocks.set(0, { index: 0, name: 'Genlock #0', timeSourcePath: null, offsetNs: null })
		const ids = ClockVariableDefinitions(state).map((d) => d.variableId)
		expect(ids).toContain('genlock_0_offset_ns')
		expect(ids).toContain('genlock_0_in_use')
	})
})
