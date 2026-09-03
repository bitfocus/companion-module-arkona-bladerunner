import { describe, expect, it } from 'vitest'
import {
	allowedDirections,
	canSetDirection,
	formatBool,
	formatStandard,
	IoState,
	isLocked,
	IoVariableDefinitions,
	IoManager,
	type BncCapability,
	type BncState,
	type SdiInputState,
} from '../io.js'
import { activeIssues, formatIssueLabel, formatIssueLabels } from '../issues.js'

const input = (over: Partial<SdiInputState> = {}): SdiInputState => ({
	index: 0,
	name: 'SDI Input 0',
	lockStatus: null,
	standard: null,
	black: null,
	frozen: null,
	...over,
})

describe('isLocked', () => {
	// LockedToRef means the port found no data and fell back to the reference - not a signal.
	it('is true only for LockedToData', () => {
		expect(isLocked(input({ lockStatus: 'LockedToData' }))).toBe(true)
		expect(isLocked(input({ lockStatus: 'LockedToRef' }))).toBe(false)
		expect(isLocked(input({ lockStatus: 'Unlocked' }))).toBe(false)
		expect(isLocked(input({ lockStatus: null }))).toBe(false)
	})

	it('treats an unknown port as unlocked rather than throwing', () => {
		expect(isLocked(undefined)).toBe(false)
	})
})

describe('activeIssues', () => {
	it('keeps only the flags that are set', () => {
		expect(
			activeIssues({
				different_genlocks: false,
				input_out_of_linephaser_range: false,
				missing_t_src: true,
				no_12g_support: false,
				std_mismatch: true,
			}),
		).toEqual(['missing_t_src', 'std_mismatch'])
	})

	it('returns empty for a clean port or a missing reading', () => {
		expect(activeIssues({ std_mismatch: false })).toEqual([])
		expect(activeIssues(null)).toEqual([])
		expect(activeIssues(undefined)).toEqual([])
	})
})

describe('formatBool', () => {
	it('keeps true and false distinct from an unclassified reading', () => {
		expect(formatBool(true)).toBe('true')
		expect(formatBool(false)).toBe('false')
		expect(formatBool(null)).toBe('unknown')
		expect(formatBool(undefined)).toBe('unknown')
	})
})

describe('formatStandard', () => {
	it('rewrites device enums for display', () => {
		expect(formatStandard('HD1080p59_94')).toBe('1080p59.94')
		expect(formatStandard('HD720p50')).toBe('720p50')
		expect(formatStandard('HD2160p50')).toBe('2160p50')
		expect(formatStandard('HD1080sF25')).toBe('1080PsF25')
		expect(formatStandard('HD1080p24_DCI')).toBe('1080p24 DCI')
		expect(formatStandard('PAL')).toBe('PAL')
	})

	it('treats a missing reading as unknown', () => {
		expect(formatStandard(null)).toBe('unknown')
		expect(formatStandard(undefined)).toBe('unknown')
		expect(formatStandard('')).toBe('unknown')
	})
})

describe('formatIssueLabels', () => {
	it('uses the known wording rather than the device key', () => {
		expect(formatIssueLabel('missing_t_src')).toBe('Missing time source')
		expect(formatIssueLabels(['missing_t_src', 'std_mismatch'])).toBe('Missing time source, Standard mismatch')
	})

	it('falls back to a spaced label for an unexpected key', () => {
		expect(formatIssueLabel('new_device_flag')).toBe('New device flag')
	})
})

describe('IoState', () => {
	// BNC numbers, not a 0-based sequence: a chassis with inputs 0-7 and outputs 8-9 is normal.
	const state = new IoState()
	state.inputs.set(0, input({ index: 0, name: 'SDI Input 0' }))
	state.inputs.set(7, input({ index: 7, name: 'SDI Input 7' }))
	state.outputs.set(8, {
		index: 8,
		standard: null,
		timeSourcePath: null,
		videoSourcePath: null,
		videoSourceName: null,
		audioSourcePath: null,
		audioSourceName: null,
		issues: [],
		resyncCount: 0,
	})

	it('labels choices by BNC index', () => {
		expect(state.inputChoices()).toEqual([
			{ id: 0, label: '0: SDI Input 0' },
			{ id: 7, label: '7: SDI Input 7' },
		])
		expect(state.outputChoices()).toEqual([{ id: 8, label: 'SDI Output 8' }])
	})

	it('names variables by BNC index', () => {
		const ids = IoVariableDefinitions(state).map((d) => d.variableId)
		expect(ids).toContain('sdi_in_7_locked')
		expect(ids).toContain('sdi_out_8_source')
		expect(ids).not.toContain('sdi_in_1_locked')
		expect(ids).not.toContain('sdi_out_0_source')
	})

	it('produces only the summary variables when the chassis has no SDI ports', () => {
		expect(IoVariableDefinitions(new IoState()).map((d) => d.variableId)).toEqual([
			'sdi_input_count',
			'sdi_output_count',
			'sdi_inputs_locked',
		])
	})
})

describe('allowedDirections', () => {
	it('offers both ways only for a reversible port', () => {
		expect(allowedDirections('ceInOut')).toEqual(['Input', 'Output'])
	})

	// An 18x2 IO board has ports wired one way only; offering the other way would be a lie.
	it('respects fixed-direction ports', () => {
		expect(allowedDirections('ceIn')).toEqual(['Input'])
		expect(allowedDirections('ceOut')).toEqual(['Output'])
	})

	it('offers nothing for a disabled port', () => {
		expect(allowedDirections('ceDisable')).toEqual([])
	})
})

describe('canSetDirection', () => {
	const bnc = (capability: BncCapability): BncState => ({ index: 0, capability, direction: 'Input' })

	it('permits only what the hardware supports', () => {
		expect(canSetDirection(bnc('ceInOut'), 'Output')).toBe(true)
		expect(canSetDirection(bnc('ceIn'), 'Output')).toBe(false)
		expect(canSetDirection(bnc('ceOut'), 'Input')).toBe(false)
		expect(canSetDirection(bnc('ceDisable'), 'Input')).toBe(false)
	})

	it('refuses a port that does not exist', () => {
		expect(canSetDirection(undefined, 'Input')).toBe(false)
	})
})

describe('BNC choices', () => {
	const state = new IoState()
	state.bncs.set(0, { index: 0, capability: 'ceInOut', direction: 'Input' })
	state.bncs.set(1, { index: 1, capability: 'ceIn', direction: 'Input' })
	state.bncs.set(2, { index: 2, capability: 'ceDisable', direction: null })

	it('offers only reversible ports to the direction action', () => {
		expect(state.reversibleBncChoices()).toEqual([{ id: 0, label: 'SDI 0 (Input)' }])
	})

	it('offers every usable port to feedbacks, but not disabled ones', () => {
		expect(state.bncChoices()).toEqual([
			{ id: 0, label: 'SDI 0' },
			{ id: 1, label: 'SDI 1' },
		])
	})

	it('adds a direction variable per BNC', () => {
		expect(IoVariableDefinitions(state).map((d) => d.variableId)).toContain('sdi_1_configuration')
	})
})

describe('IoManager.dispose', () => {
	it('removes ports and BNC capabilities inherited from the previous Blade', () => {
		const manager = new IoManager()
		manager.state.inputs.set(1, input({ index: 1 }))
		manager.state.bncs.set(1, { index: 1, capability: 'ceInOut', direction: 'Input' })

		manager.dispose()

		expect(manager.state.inputs.size).toBe(0)
		expect(manager.state.bncs.size).toBe(0)
	})
})
