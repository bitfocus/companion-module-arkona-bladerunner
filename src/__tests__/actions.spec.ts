import { describe, expect, it, vi } from 'vitest'
import { adjustedTarget, mixerTransitionTarget, UpdateActions } from '../actions.js'
import { ClockState } from '../clocks.js'
import { IoState } from '../io.js'
import { IssueState } from '../issues.js'
import { ProcessorState } from '../processors.js'
import { buildRegistry, NO_SOURCE } from '../routing.js'
import { RtpState } from '../rtp.js'

describe('mixerTransitionTarget', () => {
	it('maps A and B to the confirmed fader end stops', () => {
		expect(mixerTransitionTarget('a', 0.8)).toBe(0)
		expect(mixerTransitionTarget('b', 0.2)).toBe(1)
	})

	it('toggles away from the nearest end, including during a transition', () => {
		expect(mixerTransitionTarget('toggle', 0)).toBe(1)
		expect(mixerTransitionTarget('toggle', 0.49)).toBe(1)
		expect(mixerTransitionTarget('toggle', 0.5)).toBe(0)
		expect(mixerTransitionTarget('toggle', 1)).toBe(0)
	})
})

describe('adjustedTarget', () => {
	it('sets absolute values and clamps them to the device range', () => {
		expect(adjustedTarget('set', 0.75, null, 0, 1)).toBe(0.75)
		expect(adjustedTarget('set', 2, null, 0, 1)).toBe(1)
	})

	it('applies positive and negative increments', () => {
		expect(adjustedTarget('adjust', 0.1, 0.5, 0, 1)).toBe(0.6)
		expect(adjustedTarget('adjust', -0.2, 0.5, 0, 1)).toBe(0.3)
	})

	it('clamps adjustments and requires a current value', () => {
		expect(adjustedTarget('adjust', 0.5, 0.8, 0, 1)).toBe(1)
		expect(adjustedTarget('adjust', -0.5, 0.2, 0, 1)).toBe(0)
		expect(adjustedTarget('adjust', 0.1, null, 0, 1)).toBeNull()
	})
})

function actionHarness(vm: any, processors = new ProcessorState()) {
	let definitions: Record<string, any> = {}
	const io = new IoState()
	const rtp = new RtpState()
	const self = {
		config: { towel: 'companion' },
		connection: { vm },
		io: { state: io },
		rtp,
		processors,
		flowState: { io, rtp, processors },
		clocks: new ClockState(),
		issues: new IssueState(),
		identifyActive: false,
		log: vi.fn(),
		setActionDefinitions: (value: Record<string, any>) => {
			definitions = value
		},
	}
	UpdateActions(self as any, buildRegistry({ io, rtp, processors }))
	return { self, definitions }
}

describe('action connection requirements', () => {
	it('routes to a processor on a Blade without an SDI I/O module', async () => {
		const write = vi.fn(async () => undefined)
		const processors = new ProcessorState()
		processors.inputs.set('audio_delay_0_in', {
			id: 'audio_delay_0_in',
			node: 'audio_delay_0',
			suffix: ' In',
			takesChannel: false,
			level: 'audio',
			write,
			sourcePath: null,
			sourceName: null,
			sourceChannel: null,
		})
		processors.nodeNames.set('audio_delay_0', 'Audio Delay 0')
		const { definitions } = actionHarness({ raw: { current_towel: { value: 'companion' } } }, processors)

		await definitions.route.callback({
			options: { source: NO_SOURCE, destination: 'audio_delay_0_in', level: 'audio' },
		})

		expect(write).toHaveBeenCalledWith(null, 0)
	})

	it('does not clear RTP counters when the configured towel is not held', async () => {
		const clearErrors = vi.fn(async () => undefined)
		const clearEvents = vi.fn(async () => undefined)
		const vm = {
			raw: { current_towel: { value: 'someone-else' } },
			r_t_p_receiver: {
				video_receivers: {
					row: () => ({
						generic: {
							clear_error_counters: { write: clearErrors },
							clear_event_counters: { write: clearEvents },
						},
					}),
				},
				audio_receivers: { row: vi.fn() },
			},
		}
		const { self, definitions } = actionHarness(vm)

		await definitions.clear_rtp_counters.callback({ options: { receiver: 'v_0' } })

		expect(clearErrors).not.toHaveBeenCalled()
		expect(clearEvents).not.toHaveBeenCalled()
		expect(self.log).toHaveBeenCalledWith('warn', expect.stringContaining('someone-else'))
	})

	it('clears both RTP counter groups and reports a write failure', async () => {
		const clearErrors = vi.fn(async () => undefined)
		const clearEvents = vi.fn().mockRejectedValue(new Error('counter failure'))
		const vm = {
			raw: { current_towel: { value: 'companion' } },
			r_t_p_receiver: {
				video_receivers: {
					row: () => ({
						generic: {
							clear_error_counters: { write: clearErrors },
							clear_event_counters: { write: clearEvents },
						},
					}),
				},
				audio_receivers: { row: vi.fn() },
			},
		}
		const { self, definitions } = actionHarness(vm)

		await definitions.clear_rtp_counters.callback({ options: { receiver: 'v_0' } })

		expect(clearErrors).toHaveBeenCalledWith('Click')
		expect(clearEvents).toHaveBeenCalledWith('Click')
		expect(self.log).toHaveBeenCalledWith('error', expect.stringContaining('counter failure'))
	})
})
