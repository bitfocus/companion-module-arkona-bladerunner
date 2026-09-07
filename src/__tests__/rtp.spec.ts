import { describe, expect, it, vi } from 'vitest'
import { IssueState } from '../issues.js'
import { ProcessorState } from '../processors.js'
import {
	receiverHealthVariables,
	rtpAudioReceiverPath,
	rtpVideoReceiverPath,
	RtpState,
	RtpVariableDefinitions,
	subscribeRtp,
	transportEmbedsAudio,
} from '../rtp.js'

function keyword(initial: unknown) {
	return {
		watch: vi.fn(async (handler: (value: unknown) => void) => {
			handler(initial)
			return { unwatch: vi.fn() }
		}),
	}
}

function namedRow(name: string) {
	return {
		raw: {
			watch: vi.fn(async (_path: unknown, handler: (value: unknown) => void) => {
				handler(name)
				return { unwatch: vi.fn() }
			}),
		},
	}
}

function receiver(name: string) {
	const error = () => keyword({ err_acc: 4, consec_err_count: 2 })
	const event = () => keyword(3)
	return {
		...namedRow(name),
		generic: {
			issues: keyword({ missing_packet: true }),
			error_counters: {
				rx_error: error(),
				premature_read: error(),
				liveness_timeout: error(),
				phase_mismatch: error(),
			},
			event_counters: {
				start_a: event(),
				start_b: event(),
				switch_ab: event(),
				switch_ba: event(),
				stop: event(),
				restart: event(),
			},
			redundancy_levels: { nominally_present: { overall: keyword(2) } },
			required_redundancy_level: keyword({ sdp_a: 1, sdp_b: 1 }),
			latency_spread: { overall: keyword({ ms: () => 1.23456 }) },
		},
	}
}

function harness() {
	const values: Record<string, unknown> = {}
	const self = {
		rtp: new RtpState(),
		processors: new ProcessorState(),
		issues: new IssueState(),
		variables: { set: vi.fn((id: string, value: unknown) => void (values[id] = value)) },
		connection: { track: vi.fn() },
		checkFeedbacks: vi.fn(),
		scheduleDefinitionRefresh: vi.fn(),
		log: vi.fn(),
	} as any
	return { self, values }
}

describe('RTP metadata', () => {
	it('defines every receiver health value and stable essence paths', () => {
		const state = new RtpState()
		state.videoReceivers.set(2, { index: 2, name: 'Program Rx' })
		expect(receiverHealthVariables('rx', 'Receiver')).toHaveLength(17)
		expect(RtpVariableDefinitions(state)).toHaveLength(17)
		expect(rtpVideoReceiverPath(2)).toBe('r_t_p_receiver.video_receivers[2].media_specific.output.video')
		expect(rtpAudioReceiverPath(4)).toBe('r_t_p_receiver.audio_receivers[4].media_specific.output')
	})

	it('only treats ST 2022-6 as embedding audio', () => {
		expect(transportEmbedsAudio('ST2022_6')).toBe(true)
		expect(transportEmbedsAudio('ST2110_20')).toBe(false)
		expect(transportEmbedsAudio(null)).toBe(false)
	})
})

describe('subscribeRtp', () => {
	it('discovers endpoints and publishes receiver health and transmitter tallies', async () => {
		const h = harness()
		const videoSource = {
			raw: { kwl: 'i_o_module.input[3].sdi.output.video' },
			brief: { read: vi.fn().mockResolvedValue('Camera 3') },
		}
		const audioSource = {
			raw: { kwl: 'i_o_module.input[3].sdi.output.audio' },
			brief: { read: vi.fn().mockRejectedValue(new Error('no brief')) },
		}
		const videoTx = {
			...namedRow('Program TX'),
			generic: { issues: keyword({}) },
			v_src: { status: keyword({ source: videoSource }) },
			configuration: {
				transport_format: { status: { read: vi.fn().mockResolvedValue({ variant: 'ST2022_6' }) } },
				a_src: { status: keyword({ source: audioSource }) },
			},
		}
		const audioTx = {
			...namedRow('Clean Audio'),
			generic: { issues: keyword({}) },
			a_src: { status: keyword(null) },
		}
		const vm = {
			r_t_p_receiver: {
				video_receivers: { allocated_indices: async () => [1], row: () => receiver('Video RX') },
				audio_receivers: { allocated_indices: async () => [], row: vi.fn() },
			},
			r_t_p_transmitter: {
				video_transmitters: { allocated_indices: async () => [2], row: () => videoTx },
				audio_transmitters: { allocated_indices: async () => [5], row: () => audioTx },
			},
		} as any

		await subscribeRtp(h.self, vm)
		await Promise.resolve()

		expect(h.self.rtp.videoReceivers.get(1)?.name).toBe('Video RX')
		expect(h.self.rtp.videoTransmitters.get(2)).toMatchObject({
			name: 'Program TX',
			embedsAudio: true,
			videoSourcePath: 'i_o_module.input[3].sdi.output.video',
			videoSourceName: 'Camera 3',
			audioSourceName: null,
		})
		expect(h.values.rtp_rx_v_1_rx_errors).toBe(4)
		expect(h.values.rtp_rx_v_1_rx_errors_consecutive).toBe(2)
		expect(h.values.rtp_rx_v_1_redundancy_required).toBe('1/1')
		expect(h.values.rtp_rx_v_1_latency_spread_ms).toBe('1.235')
		expect(h.values.dest_rtp_tx_v_2_video_active_source).toBe('sdi_in_3')
		expect(h.values.dest_rtp_tx_v_2_video_active_source_label).toBe('Camera 3')
		expect(h.values.dest_rtp_tx_v_2_audio_active_source_label).toBe('i_o_module.input[3].sdi.output.audio')
		expect(h.values.dest_rtp_tx_a_5_audio_active_source).toBe('')
		expect(h.values.dest_rtp_tx_v_2_breakaway).toBe('false')
		const updateAudio = videoTx.configuration.a_src.status.watch.mock.calls[0][0]
		updateAudio(null)
		expect(h.values.dest_rtp_tx_v_2_breakaway).toBe('true')
		expect(h.self.checkFeedbacks).toHaveBeenLastCalledWith('flow_routed', 'flow_breakaway')
		updateAudio({ source: audioSource })
		expect(h.values.dest_rtp_tx_v_2_breakaway).toBe('false')
		expect(h.values).not.toHaveProperty('dest_rtp_tx_a_5_breakaway')
		expect(h.self.connection.track).toHaveBeenCalled()
		expect(h.self.log).toHaveBeenCalledWith('info', 'RTP endpoints: 1 video rx, 0 audio rx, 1 video tx, 1 audio tx')
	})

	it('skips absent hardware and omits audio watches for non-embedding video formats', async () => {
		const absent = harness()
		await subscribeRtp(absent.self, {} as any)
		expect(absent.self.log).toHaveBeenCalledWith(
			'info',
			'This Blade has no RTP receiver or transmitter; skipping IP endpoints',
		)

		const h = harness()
		const audioStatus = keyword(null)
		const row = {
			...namedRow('2110 TX'),
			generic: { issues: keyword({}) },
			v_src: { status: keyword(null) },
			configuration: {
				transport_format: { status: { read: vi.fn().mockResolvedValue({ variant: 'ST2110_20' }) } },
				a_src: { status: audioStatus },
			},
		}
		await subscribeRtp(h.self, {
			r_t_p_transmitter: {
				video_transmitters: { allocated_indices: async () => [0], row: () => row },
				audio_transmitters: { allocated_indices: async () => [], row: vi.fn() },
			},
		} as any)
		expect(h.self.rtp.videoTransmitters.get(0)?.embedsAudio).toBe(false)
		expect(audioStatus.watch).not.toHaveBeenCalled()
	})
})
