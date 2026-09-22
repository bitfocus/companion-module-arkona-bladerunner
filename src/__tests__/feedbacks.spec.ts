import { describe, expect, it, vi } from 'vitest'
import { ClockState } from '../clocks.js'
import { UpdateFeedbacks } from '../feedbacks.js'
import { IoState } from '../io.js'
import { ANY_ISSUE_SOURCE, IssueState } from '../issues.js'
import { ProcessorState } from '../processors.js'
import { buildRegistry, NO_SOURCE } from '../routing.js'
import { RtpState } from '../rtp.js'

function harness() {
	const io = new IoState()
	io.inputs.set(1, {
		index: 1,
		name: 'Camera',
		lockStatus: 'LockedToData',
		standard: 'HD1080p50',
		black: true,
		frozen: false,
	})
	io.outputs.set(8, {
		index: 8,
		standard: 'HD1080p50',
		timeSourcePath: 'genlock.instances[0].backend.output',
		videoSourcePath: 'i_o_module.input[1].sdi.output.video',
		videoSourceName: 'Camera',
		audioSourcePath: null,
		audioSourceName: null,
		issues: ['missing_t_src'],
		resyncCount: 0,
	})
	io.bncs.set(1, { index: 1, capability: 'ceInOut', direction: 'Input' })
	const rtp = new RtpState()
	const processors = new ProcessorState()
	const clocks = new ClockState()
	const issues = new IssueState()
	issues.sources.set('temperature', { id: 'temperature', label: 'Temperature', flags: ['too_hot'] })
	let definitions: Record<string, any> = {}
	const flowState = { io, rtp, processors }
	const self = {
		io: { state: io },
		rtp,
		processors,
		clocks,
		issues,
		flowState,
		identifyActive: true,
		flowRegistry: () => buildRegistry(flowState),
		setFeedbackDefinitions: vi.fn((value) => {
			definitions = value
		}),
	}
	UpdateFeedbacks(self as any, buildRegistry(flowState))
	return { self, definitions }
}

const feedback = (options: Record<string, unknown> = {}) => ({ options })

describe('feedback callbacks', () => {
	it('requires every selected routing level to match', () => {
		const { definitions } = harness()
		expect(
			definitions.flow_routed.callback(feedback({ source: 'sdi_in_1', destination: 'sdi_out_8', level: 'video' })),
		).toBe(true)
		expect(
			definitions.flow_routed.callback(feedback({ source: 'sdi_in_1', destination: 'sdi_out_8', level: 'both' })),
		).toBe(false)
		expect(definitions.flow_breakaway.callback(feedback({ destination: 'sdi_out_8' }))).toBe(true)
	})

	it('tallies a deliberately cleared level', () => {
		const { definitions } = harness()
		expect(
			definitions.flow_routed.callback(feedback({ source: NO_SOURCE, destination: 'sdi_out_8', level: 'audio' })),
		).toBe(true)
	})

	it('evaluates SDI status and issue feedbacks from live state', () => {
		const { definitions } = harness()
		expect(definitions.sdi_input_locked.callback(feedback({ input: 1 }))).toBe(true)
		expect(definitions.sdi_input_black.callback(feedback({ input: 1 }))).toBe(true)
		expect(definitions.sdi_input_frozen.callback(feedback({ input: 1 }))).toBe(false)
		expect(definitions.sdi_input_standard.callback(feedback({ input: 1, standard: 'HD1080p50' }))).toBe(true)
		expect(definitions.sdi_output_active.callback(feedback({ output: 8 }))).toBe(true)
		expect(definitions.sdi_output_issues.callback(feedback({ output: 8, issue: 'missing_t_src' }))).toBe(true)
	})

	it('evaluates device and clock state synchronously', () => {
		const { self, definitions } = harness()
		self.clocks.ptp.state = 'CalibratedAndLocked'
		self.clocks.genlocks.set(0, { index: 0, name: 'Genlock', timeSourcePath: 'ptp', offsetNs: 0 })
		expect(definitions.identify.callback(feedback())).toBe(true)
		expect(definitions.ptp_locked.callback(feedback())).toBe(true)
		expect(definitions.genlock_in_use.callback(feedback({ genlock: 0 }))).toBe(true)
		expect(definitions.has_issues.callback(feedback({ source: ANY_ISSUE_SOURCE }))).toBe(true)
		expect(definitions.has_issues.callback(feedback({ source: 'temperature' }))).toBe(true)
	})

	it('uses the selected source channel for shuffler tallies', () => {
		const { self } = harness()
		self.processors.inputs.set('shuffle_in_0', {
			id: 'shuffle_in_0',
			node: 'shuffle',
			suffix: ' In 0',
			takesChannel: true,
			level: 'audio',
			write: vi.fn(),
			sourcePath: 'i_o_module.input[1].sdi.output.audio',
			sourceName: 'Camera ch 3',
			sourceChannel: 3,
		})
		self.processors.nodeNames.set('shuffle', 'Shuffler')
		let definitions: Record<string, any> = {}
		self.setFeedbackDefinitions.mockImplementation((value: Record<string, any>) => {
			definitions = value
		})
		UpdateFeedbacks(self as any, buildRegistry(self.flowState))
		expect(
			definitions.flow_routed.callback(
				feedback({ source: 'sdi_in_1', destination: 'shuffle_in_0', level: 'audio', source_channel: 3 }),
			),
		).toBe(true)
		expect(
			definitions.flow_routed.callback(
				feedback({ source: 'sdi_in_1', destination: 'shuffle_in_0', level: 'audio', source_channel: 4 }),
			),
		).toBe(false)
	})
})
