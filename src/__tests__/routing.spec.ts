import { describe, expect, it } from 'vitest'
import { IoState, type SdiInputState, type SdiOutputState } from '../io.js'
import { ProcessorState, type ProcessorInput } from '../processors.js'
import { RtpState } from '../rtp.js'
import {
	buildRegistry,
	destinationId,
	FlowVariableDefinitions,
	flowRegistryValues,
	indexForDestinationId,
	indexForSourceId,
	NO_SOURCE,
	sourceChoices,
	sourceId,
	sourceIdForPath,
	allGeneratorSources,
	isSelfLoop,
	isBreakaway,
	levelsForOption,
	resolveDestinationWriter,
	resolveSourceEssence,
	sourceChannelOption,
} from '../routing.js'

const noRtp = (): RtpState => new RtpState()

/** The aggregate `buildRegistry` projects from. */
const flowState = (io: IoState, rtp: RtpState = new RtpState(), processors = new ProcessorState()) => ({
	io,
	rtp,
	processors,
})

const input = (index: number, name: string): SdiInputState => ({
	index,
	name,
	lockStatus: 'LockedToData',
	standard: 'HD1080p50',
	black: false,
	frozen: false,
})

const output = (
	index: number,
	videoSourcePath: string | null,
	videoSourceName: string | null = null,
	audioSourcePath: string | null = null,
	audioSourceName: string | null = null,
): SdiOutputState => ({
	index,
	standard: null,
	timeSourcePath: null,
	videoSourcePath,
	videoSourceName,
	audioSourcePath,
	audioSourceName,
	issues: [],
	resyncCount: 0,
})

/** The real chassis: BNCs 0-7 in, 8-9 out. Indices are port numbers, not positions. */
function chassis(): IoState {
	const state = new IoState()
	for (let i = 0; i <= 7; i++) state.inputs.set(i, input(i, `SDI Input ${i}`))
	// out 8 follows input 3 on both levels; out 9 is unrouted entirely.
	state.outputs.set(
		8,
		output(
			8,
			'i_o_module.input[3].sdi.output.video',
			'SDI Input 3',
			'i_o_module.input[3].sdi.output.audio',
			'SDI Input 3',
		),
	)
	state.outputs.set(9, output(9, null))
	return state
}

describe('sourceIdForPath', () => {
	it('maps an SDI input essence path to its source ID, per level', () => {
		expect(sourceIdForPath('i_o_module.input[3].sdi.output.video', 'video', new ProcessorState())).toBe('sdi_in_3')
		expect(sourceIdForPath('i_o_module.input[10].sdi.output.video', 'video', new ProcessorState())).toBe('sdi_in_10')
		expect(sourceIdForPath('i_o_module.input[3].sdi.output.audio', 'audio', new ProcessorState())).toBe('sdi_in_3')
	})

	// One source ID addresses both levels, but a path still belongs to exactly one of them.
	it('does not accept an audio path as a video source, or the reverse', () => {
		expect(sourceIdForPath('i_o_module.input[3].sdi.output.audio', 'video', new ProcessorState())).toBeNull()
		expect(sourceIdForPath('i_o_module.input[3].sdi.output.video', 'audio', new ProcessorState())).toBeNull()
	})

	// Routing to a mixer output is legal on the device but outside this pass's scope. Reporting it
	// as some SDI input would hand the router an ID its own route action cannot accept.
	it('returns null for a source outside the SDI scope, rather than guessing', () => {
		// MADI inputs are real audio essences on the device but are not registered as sources yet.
		expect(sourceIdForPath('i_o_module.input[0].madi.output', 'audio', new ProcessorState())).toBeNull()
		expect(
			sourceIdForPath('audio_signal_generator.genlock[0].f96000.signal_400hz', 'audio', new ProcessorState()),
		).toBeNull()
	})

	it('returns null for no source', () => {
		expect(sourceIdForPath(null, 'video', new ProcessorState())).toBeNull()
		expect(sourceIdForPath('', 'audio', new ProcessorState())).toBeNull()
	})
})

describe('ID parsing', () => {
	it('round-trips port IDs', () => {
		expect(indexForSourceId(sourceId(7))).toBe(7)
		expect(indexForDestinationId(destinationId(9))).toBe(9)
		expect(indexForSourceId(sourceId(0))).toBe(0)
	})

	it('keeps the source and destination namespaces separate', () => {
		expect(indexForSourceId('sdi_out_8')).toBeNull()
		expect(indexForDestinationId('sdi_in_0')).toBeNull()
	})

	// Otherwise `sdi_in_01` and `sdi_in_1` would both resolve to port 1, and a saved route could
	// silently target the wrong thing.
	it('rejects IDs that are not exactly one port', () => {
		expect(indexForSourceId('sdi_in_01')).toBeNull()
		expect(indexForSourceId('sdi_in_1x')).toBeNull()
		expect(indexForSourceId('sdi_in_')).toBeNull()
		expect(indexForSourceId('nonsense')).toBeNull()
	})
})

describe('buildRegistry', () => {
	it('names SDI ports by BNC number, not array position', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		const sdi = [...registry.sources.values()].filter((s) => s.kind === 'sdi').map((s) => s.id)
		expect(sdi).toEqual([
			'sdi_in_0',
			'sdi_in_1',
			'sdi_in_2',
			'sdi_in_3',
			'sdi_in_4',
			'sdi_in_5',
			'sdi_in_6',
			'sdi_in_7',
		])
		expect([...registry.destinations.keys()]).toEqual(['sdi_out_8', 'sdi_out_9'])
	})

	it('includes the signal generators, which exist regardless of the SDI layout', () => {
		// Present even on a chassis with no SDI ports at all.
		const ids = [...buildRegistry(flowState(new IoState(), noRtp())).sources.keys()]
		expect(ids).toContain('vsg_0')
		expect(ids).toContain('vsg_1')
		expect(ids).toContain('asg_alsa_0')
		expect(ids).toContain('asg_g0_f48000_1000hz')
		expect(ids).toContain('asg_g2_f48000_silence')
		// 48 kHz only, matching the Blade's own web UI; 96 kHz is deliberately not exposed yet.
		expect(ids.some((id) => id.includes('f96000'))).toBe(false)
		// 2 video + ALSA + 3 generators x 4 signals
		expect(ids.length).toBe(2 + 1 + 12)
	})

	it('marks which levels each source can feed', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		expect(registry.sources.get('sdi_in_0')?.levels).toEqual(['video', 'audio'])
		expect(registry.sources.get('vsg_0')?.levels).toEqual(['video'])
		expect(registry.sources.get('asg_g0_f48000_400hz')?.levels).toEqual(['audio'])
	})

	it('gives every generator a distinct label, since the device repeats its own', () => {
		const registry = buildRegistry(flowState(new IoState(), noRtp()))
		const labels = [...registry.sources.values()].map((s) => s.label)
		expect(new Set(labels).size).toBe(labels.length)
		expect(registry.sources.get('asg_g1_f48000_1000hz')?.label).toBe('Sig Gen 1 f48000 1 kHz')
	})

	it('resolves the tally to a source ID on each level', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		const out8 = registry.destinations.get('sdi_out_8')
		expect(out8?.active.video.sourceId).toBe('sdi_in_3')
		expect(out8?.active.audio.sourceId).toBe('sdi_in_3')
		const out9 = registry.destinations.get('sdi_out_9')
		expect(out9?.active.video.sourceId).toBeNull()
		expect(out9?.active.audio.sourceId).toBeNull()
	})

	it('shows an out-of-scope source to a human while reporting no routable ID', () => {
		const io = new IoState()
		// A UDX output is a real essence on other Blades, but nothing this module registers.
		io.outputs.set(8, output(8, 'u_d_x.instances[0].output.video', 'UDX #0'))
		const destination = buildRegistry(flowState(io, noRtp())).destinations.get('sdi_out_8')
		expect(destination?.active.video.sourceId).toBeNull()
		expect(destination?.active.video.label).toBe('UDX #0')
	})

	// Now that processors are endpoints, a destination fed from one reports a routable ID - but only
	// for an output discovery actually registered, since that is what makes it a source.
	it('resolves a processor output feeding an SDI destination', () => {
		const io = new IoState()
		io.outputs.set(8, output(8, 'video_mixer.instances[0].output', 'Mixer #0'))
		const processors = new ProcessorState()
		processors.addOutput({
			id: 'mixer_0_out',
			node: 'mixer_0',
			suffix: ' Output',
			level: 'video',
			path: 'video_mixer.instances[0].output',
		})
		const destination = buildRegistry(flowState(io, noRtp(), processors)).destinations.get('sdi_out_8')
		expect(destination?.active.video.sourceId).toBe('mixer_0_out')
	})

	// A BNC flipping direction must never hand an existing ID to a different port.
	it('keeps IDs stable when a BNC changes direction', () => {
		const before = buildRegistry(flowState(chassis(), noRtp()))
		const after = chassis()
		after.inputs.delete(7)
		after.outputs.set(7, output(7, null))
		const registry = buildRegistry(flowState(after, noRtp()))

		expect(registry.sources.has('sdi_in_7')).toBe(false)
		expect(registry.destinations.has('sdi_out_7')).toBe(true)
		// Every surviving source still names the same essence on the device.
		for (const id of registry.sources.keys()) {
			expect(before.sources.get(id)?.path).toBe(registry.sources.get(id)?.path)
		}
	})

	it('copes with a chassis that has no outputs at all', () => {
		const state = new IoState()
		state.inputs.set(0, input(0, 'SDI Input 0'))
		const registry = buildRegistry(flowState(state, noRtp()))
		expect(registry.destinations.size).toBe(0)
		expect(flowRegistryValues(registry).flow_destinations).toBe('')
	})
})

describe('router contract', () => {
	// The whole point of the spec: the value of dest_*_active_source must be a value the route
	// action's source option accepts. If these two ever drift, routing silently breaks.
	it('publishes active-source values that are valid route sources', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		const validSourceIds = new Set(sourceChoices(registry).map((c) => String(c.id)))

		for (const destination of registry.destinations.values()) {
			for (const level of ['video', 'audio'] as const) {
				const published = destination.active[level].sourceId ?? NO_SOURCE
				expect(validSourceIds.has(published)).toBe(true)
			}
		}
	})

	it('defines one active-source variable per level per destination', () => {
		const ids = FlowVariableDefinitions(buildRegistry(flowState(chassis(), noRtp()))).map((d) => d.variableId)
		expect(ids).toContain('dest_sdi_out_8_video_active_source')
		expect(ids).toContain('dest_sdi_out_8_audio_active_source')
		expect(ids).toContain('dest_sdi_out_9_video_active_source')
		expect(ids).toContain('dest_sdi_out_8_breakaway')
		expect(ids).toContain('src_label_sdi_in_0')
		expect(ids).toContain('dst_label_sdi_out_8')
		// The combined single-level variable is deliberately gone: a destination in breakaway has no
		// single active source, so reporting one would be a lie.
		expect(ids).not.toContain('dest_sdi_out_8_active_source')
	})

	it('lists the available ports for discovery', () => {
		const values = flowRegistryValues(buildRegistry(flowState(chassis(), noRtp())))
		// 8 SDI inputs plus the generators.
		expect(values.flow_source_count).toBe(8 + 15)
		expect(values.flow_destination_count).toBe(2)
		expect(values.flow_destinations).toBe('sdi_out_8,sdi_out_9')
		expect(values.src_label_sdi_in_0).toBe('SDI Input 0')
	})
})

describe('resolving a port that does not exist', () => {
	// `table.row(n)` returns a row object for any index, so membership must be checked explicitly -
	// otherwise a stale saved route reaches the device and fails as a read timeout on a phantom port.
	const vm = {
		i_o_module: { input: { row: () => ({ sdi: { output: {} } }) }, output: { row: () => ({ sdi: {} }) } },
	} as any
	/** Stands in for reviving an essence, so the path chosen is visible to the assertion. */
	const revive = ((path: string, level: string) => `${level}:${path}`) as any

	it('refuses IDs outside the registry', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		expect(resolveDestinationWriter(vm, registry, 'sdi_out_99', new ProcessorState())).toBeNull()
		expect(resolveSourceEssence(registry, 'sdi_in_99', 'video', revive)).toBeNull()
		expect(resolveSourceEssence(registry, 'nonsense', 'audio', revive)).toBeNull()
	})

	it('refuses a level the source cannot feed', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		expect(resolveSourceEssence(registry, 'vsg_0', 'audio', revive)).toBeNull()
		expect(resolveSourceEssence(registry, 'asg_g0_f48000_400hz', 'video', revive)).toBeNull()
	})

	it('resolves each source kind to the right essence path', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		// An SDI source names its video essence; the audio one is its sibling.
		expect(resolveSourceEssence(registry, 'sdi_in_3', 'video', revive)).toBe(
			'video:i_o_module.input[3].sdi.output.video',
		)
		expect(resolveSourceEssence(registry, 'sdi_in_3', 'audio', revive)).toBe(
			'audio:i_o_module.input[3].sdi.output.audio',
		)
		expect(resolveSourceEssence(registry, 'vsg_1', 'video', revive)).toBe(
			'video:video_signal_generator.instances[1].output',
		)
		expect(resolveSourceEssence(registry, 'asg_g2_f48000_440hz', 'audio', revive)).toBe(
			'audio:audio_signal_generator.genlock[2].f48000.signal_440hz',
		)
	})

	it('refuses a port that has since changed direction', () => {
		const flipped = chassis()
		flipped.inputs.delete(7)
		flipped.outputs.set(7, output(7, null))
		expect(resolveSourceEssence(buildRegistry(flowState(flipped, noRtp())), 'sdi_in_7', 'video', revive)).toBeNull()
	})
})

describe('levels', () => {
	it('expands the route level option', () => {
		expect(levelsForOption('video')).toEqual(['video'])
		expect(levelsForOption('audio')).toEqual(['audio'])
		expect(levelsForOption('both')).toEqual(['video', 'audio'])
	})

	// The live case that prompted levels: output 8 had video from one input and no audio at all.
	it('detects a breakaway', () => {
		const state = new IoState()
		state.outputs.set(8, output(8, 'i_o_module.input[5].sdi.output.video', 'SDI Input 5'))
		expect(isBreakaway(buildRegistry(flowState(state, noRtp())).destinations.get('sdi_out_8'))).toBe(true)
	})

	it('does not call a following destination a breakaway', () => {
		expect(isBreakaway(buildRegistry(flowState(chassis(), noRtp())).destinations.get('sdi_out_8'))).toBe(false)
	})

	it('does not call a fully cleared destination a breakaway', () => {
		expect(isBreakaway(buildRegistry(flowState(chassis(), noRtp())).destinations.get('sdi_out_9'))).toBe(false)
	})
})

describe('generator source IDs', () => {
	// These persist in user configs, so they must be derived from the device path, never from a
	// position in a list that could be reordered.
	it('are stable and unique', () => {
		const generators = allGeneratorSources()
		const ids = generators.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(generators.find((g) => g.id === 'asg_g0_f48000_silence')?.path).toBe(
			'audio_signal_generator.genlock[0].f48000.signal_silence',
		)
		expect(generators.find((g) => g.id === 'vsg_0')?.path).toBe('video_signal_generator.instances[0].output')
	})

	it('round-trip from a routed path back to the source ID', () => {
		for (const generator of allGeneratorSources()) {
			expect(sourceIdForPath(generator.path, generator.levels[0], new ProcessorState())).toBe(generator.id)
		}
	})

	it('do not resolve on the wrong level', () => {
		expect(sourceIdForPath('video_signal_generator.instances[0].output', 'audio', new ProcessorState())).toBeNull()
		expect(sourceIdForPath('audio_signal_generator.alsa[0].output', 'video', new ProcessorState())).toBeNull()
	})
})

describe('RTP endpoints', () => {
	function withRtp(): RtpState {
		const rtp = new RtpState()
		rtp.videoReceivers.set(0, { index: 0, name: 'RTP Rx  #0-0' })
		rtp.videoTransmitters.set(0, {
			index: 0,
			name: 'RTP Tx 2110 #1-0',
			carriesVideo: true,
			embedsAudio: false,
			videoSourcePath: 'i_o_module.input[2].sdi.output.video',
			videoSourceName: 'SDI Input 2',
			audioSourcePath: null,
			audioSourceName: null,
		})
		rtp.audioTransmitters.set(3, {
			index: 3,
			name: 'RTP Audio Tx 3',
			carriesVideo: false,
			embedsAudio: true,
			videoSourcePath: null,
			videoSourceName: null,
			audioSourcePath: null,
			audioSourceName: null,
		})
		return rtp
	}

	it('adds receivers as sources and transmitters as destinations', () => {
		const registry = buildRegistry(flowState(chassis(), withRtp()))
		expect(registry.sources.get('rtp_rx_v_0')?.label).toBe('RTP Rx  #0-0')
		expect(registry.destinations.get('rtp_tx_v_0')?.label).toBe('RTP Tx 2110 #1-0')
	})

	// Receivers are per-level tables, unlike an SDI port which carries both on one connector.
	it('treats RTP endpoints as single- or dual-level as the device does', () => {
		const registry = buildRegistry(flowState(chassis(), withRtp()))
		expect(registry.sources.get('rtp_rx_v_0')?.levels).toEqual(['video'])
		// An ST 2110 video flow carries no audio, so it is a video-only destination.
		expect(registry.destinations.get('rtp_tx_v_0')?.levels).toEqual(['video'])
		expect(registry.destinations.get('rtp_tx_a_3')?.levels).toEqual(['audio'])
	})

	it('resolves an RTP transmitter tally back to a source ID', () => {
		const registry = buildRegistry(flowState(chassis(), withRtp()))
		expect(registry.destinations.get('rtp_tx_v_0')?.active.video.sourceId).toBe('sdi_in_2')
		expect(registry.destinations.get('rtp_tx_v_0')?.active.audio.sourceId).toBeNull()
	})

	// The device rejects a write to configuration.a_src on an ST 2110 flow, so the audio level must
	// be absent rather than offered and failing.
	it('offers audio on a video transmitter only when the transport format embeds it', () => {
		const rtp = withRtp()
		expect(buildRegistry(flowState(chassis(), rtp)).destinations.get('rtp_tx_v_0')?.levels).toEqual(['video'])
		rtp.videoTransmitters.get(0)!.embedsAudio = true
		expect(buildRegistry(flowState(chassis(), rtp)).destinations.get('rtp_tx_v_0')?.levels).toEqual(['video', 'audio'])
	})

	it('maps receiver essence paths back to their IDs, per level', () => {
		expect(
			sourceIdForPath('r_t_p_receiver.video_receivers[0].media_specific.output.video', 'video', new ProcessorState()),
		).toBe('rtp_rx_v_0')
		expect(
			sourceIdForPath('r_t_p_receiver.audio_receivers[1].media_specific.output', 'audio', new ProcessorState()),
		).toBe('rtp_rx_a_1')
		// A video receiver path is not an audio source.
		expect(
			sourceIdForPath('r_t_p_receiver.video_receivers[0].media_specific.output.video', 'audio', new ProcessorState()),
		).toBeNull()
	})

	it('keeps the audio and video transmitter ID namespaces separate', () => {
		const registry = buildRegistry(flowState(chassis(), withRtp()))
		// Both are index 0 and 3 respectively, but they are different tables on the device.
		expect(registry.destinations.has('rtp_tx_v_0')).toBe(true)
		expect(registry.destinations.has('rtp_tx_a_0')).toBe(false)
		expect(registry.destinations.has('rtp_tx_a_3')).toBe(true)
	})

	it('leaves the registry SDI-only when no RTP endpoints are allocated', () => {
		const registry = buildRegistry(flowState(chassis(), noRtp()))
		expect([...registry.destinations.keys()]).toEqual(['sdi_out_8', 'sdi_out_9'])
		expect([...registry.sources.keys()].some((id) => id.startsWith('rtp_'))).toBe(false)
	})
})

describe('destination writers', () => {
	const registry = buildRegistry(
		flowState(
			chassis(),
			(() => {
				const rtp = new RtpState()
				rtp.videoTransmitters.set(0, {
					index: 0,
					name: 'RTP Tx',
					carriesVideo: true,
					embedsAudio: true,
					videoSourcePath: null,
					videoSourceName: null,
					audioSourcePath: null,
					audioSourceName: null,
				})
				rtp.audioTransmitters.set(1, {
					index: 1,
					name: 'RTP Audio Tx',
					carriesVideo: false,
					embedsAudio: true,
					videoSourcePath: null,
					videoSourceName: null,
					audioSourcePath: null,
					audioSourceName: null,
				})
				return rtp
			})(),
		),
	)

	const vm = {
		i_o_module: {
			output: {
				row: () => ({
					sdi: { set_video_source: async () => undefined },
					a_src: { command: { write: async () => undefined } },
				}),
			},
		},
		r_t_p_transmitter: {
			video_transmitters: {
				row: () => ({
					v_src: { command: { write: async () => undefined } },
					configuration: { a_src: { command: { write: async () => undefined } } },
				}),
			},
			audio_transmitters: { row: () => ({ a_src: { command: { write: async () => undefined } } }) },
		},
	} as any

	it('gives an SDI output both levels', () => {
		const writer = resolveDestinationWriter(vm, registry, 'sdi_out_8', new ProcessorState())
		expect(typeof writer?.video).toBe('function')
		expect(typeof writer?.audio).toBe('function')
	})

	it('gives an RTP video transmitter both levels', () => {
		const writer = resolveDestinationWriter(vm, registry, 'rtp_tx_v_0', new ProcessorState())
		expect(typeof writer?.video).toBe('function')
		expect(typeof writer?.audio).toBe('function')
	})

	// An audio streamer has nothing to write video to, so the level must be absent rather than
	// present-and-failing at the device.
	it('gives an RTP audio transmitter audio only', () => {
		const writer = resolveDestinationWriter(vm, registry, 'rtp_tx_a_1', new ProcessorState())
		expect(writer?.video).toBeUndefined()
		expect(typeof writer?.audio).toBe('function')
	})

	it('omits the audio write on a video transmitter that does not embed audio', () => {
		const rtp = new RtpState()
		rtp.videoTransmitters.set(0, {
			index: 0,
			name: 'RTP Tx 2110',
			carriesVideo: true,
			embedsAudio: false,
			videoSourcePath: null,
			videoSourceName: null,
			audioSourcePath: null,
			audioSourceName: null,
		})
		const writer = resolveDestinationWriter(
			vm,
			buildRegistry(flowState(chassis(), rtp)),
			'rtp_tx_v_0',
			new ProcessorState(),
		)
		expect(typeof writer?.video).toBe('function')
		expect(writer?.audio).toBeUndefined()
	})

	it('refuses an unknown destination', () => {
		expect(resolveDestinationWriter(vm, registry, 'nonsense', new ProcessorState())).toBeNull()
	})
})

describe('processors as flow endpoints', () => {
	function withProcessors(): ProcessorState {
		const p = new ProcessorState()
		for (const [node, name] of [
			['mixer_0', 'Mixer 0'],
			['delay_0', 'Delay 0'],
			['audio_delay_0', 'Audio Delay 0'],
		]) {
			p.nodeNames.set(node, name)
		}
		const input = (id: string, node: string, suffix: string, rest: Partial<ProcessorInput> = {}) =>
			p.inputs.set(id, {
				id,
				node,
				suffix,
				takesChannel: false,
				write: async () => undefined,
				level: 'video',
				sourcePath: null,
				sourceName: null,
				sourceChannel: null,
				...rest,
			})

		input('mixer_0_a', 'mixer_0', ' A', {
			sourcePath: 'i_o_module.input[1].sdi.output.video',
			sourceName: 'SDI Input 1',
		})
		input('mixer_0_b', 'mixer_0', ' B')
		input('delay_0_in_0', 'delay_0', ' In 0')
		input('audio_delay_0_in', 'audio_delay_0', ' In', {
			level: 'audio',
			sourcePath: 'i_o_module.input[1].sdi.output.audio',
			sourceName: 'SDI Input 1 Audio',
		})

		p.addOutput({
			id: 'audio_delay_0_out_0',
			node: 'audio_delay_0',
			suffix: ' Out 0',
			level: 'audio',
			path: 're_play.audio.delays[0].outputs[0].audio',
		})
		p.addOutput({
			id: 'mixer_0_out',
			node: 'mixer_0',
			suffix: ' Output',
			level: 'video',
			path: 'video_mixer.instances[0].output',
		})
		p.addOutput({
			id: 'delay_0_out_0',
			node: 'delay_0',
			suffix: ' Out 0',
			level: 'video',
			path: 're_play.video.delays[0].outputs[0].video',
		})
		return p
	}

	const registry = () => buildRegistry(flowState(chassis(), noRtp(), withProcessors()))

	// This is the whole design: a processor needs no special handling because it is simply present
	// on both sides of the graph.
	it('registers processor outputs as sources and inputs as destinations', () => {
		const r = registry()
		expect(r.sources.get('mixer_0_out')?.path).toBe('video_mixer.instances[0].output')
		expect(r.sources.get('delay_0_out_0')?.path).toBe('re_play.video.delays[0].outputs[0].video')
		expect(r.destinations.get('mixer_0_a')?.label).toBe('Mixer 0 A')
		expect(r.destinations.get('delay_0_in_0')?.label).toBe('Delay 0 In 0')
	})

	// A video delay has one video in and one video out - offering an audio level on it would be a
	// route that can never be applied.
	it('gives each processor only its own level', () => {
		const r = registry()
		expect(r.sources.get('mixer_0_out')?.levels).toEqual(['video'])
		expect(r.destinations.get('mixer_0_a')?.levels).toEqual(['video'])
		expect(r.destinations.get('delay_0_in_0')?.levels).toEqual(['video'])
		expect(r.sources.get('audio_delay_0_out_0')?.levels).toEqual(['audio'])
		expect(r.destinations.get('audio_delay_0_in')?.levels).toEqual(['audio'])
	})

	it('tallies an audio delay input on the audio level', () => {
		const d = registry().destinations.get('audio_delay_0_in')
		expect(d?.active.audio.sourceId).toBe('sdi_in_1')
		expect(d?.active.video.sourceId).toBeNull()
	})

	// A single-level destination has nothing to break away from.
	it('never reports a breakaway on a single-level destination', () => {
		expect(isBreakaway(registry().destinations.get('delay_0_in_0'))).toBe(false)
		expect(isBreakaway(registry().destinations.get('audio_delay_0_in'))).toBe(false)
	})

	it('marks only a shuffler input as taking a source channel', () => {
		const p = withProcessors()
		p.nodeNames.set('shuffler_0', 'Shuffler 0')
		p.inputs.set('shuffler_0_in_0', {
			id: 'shuffler_0_in_0',
			node: 'shuffler_0',
			suffix: ' In 0',
			takesChannel: true,
			write: async () => undefined,
			level: 'audio',
			sourcePath: 'i_o_module.input[1].sdi.output.audio',
			sourceName: 'SDI Input 1 ch 3',
			sourceChannel: 3,
		})
		const r = buildRegistry(flowState(chassis(), noRtp(), p))
		expect(sourceChannelOption(r).isVisibleExpression).toBe(
			`arrayIncludes(jsonparse('["shuffler_0_in_0"]'), $(options:destination))`,
		)
		expect(r.destinations.get('shuffler_0_in_0')?.active.audio.channel).toBe(3)
		expect(r.destinations.get('delay_0_in_0')?.takesChannel).toBe(false)

		const ids = new Set(FlowVariableDefinitions(r).map((v) => v.variableId))
		expect(ids.has('dest_shuffler_0_in_0_audio_active_source_channel')).toBe(true)
		expect(ids.has('dest_delay_0_in_0_video_active_source_channel')).toBe(false)
	})

	it('defines variables only for the levels a processor carries', () => {
		const ids = new Set(FlowVariableDefinitions(registry()).map((v) => v.variableId))
		expect(ids.has('dest_delay_0_in_0_video_active_source')).toBe(true)
		expect(ids.has('dest_delay_0_in_0_audio_active_source')).toBe(false)
		expect(ids.has('dest_delay_0_in_0_breakaway')).toBe(false)
		expect(ids.has('dest_audio_delay_0_in_audio_active_source')).toBe(true)
		expect(ids.has('dest_audio_delay_0_in_video_active_source')).toBe(false)
		// An SDI output still carries both levels and its breakaway.
		expect(ids.has('dest_sdi_out_8_audio_active_source')).toBe(true)
		expect(ids.has('dest_sdi_out_8_breakaway')).toBe(true)
	})

	it('tallies a processor input like any other destination', () => {
		expect(registry().destinations.get('mixer_0_a')?.active.video.sourceId).toBe('sdi_in_1')
		expect(registry().destinations.get('mixer_0_b')?.active.video.sourceId).toBeNull()
	})

	// Chaining is just two ordinary routes, so a processor output must be a valid source for the
	// route action exactly like an SDI input is.
	it('lets a processor output feed another processor', () => {
		const r = registry()
		const validSources = new Set(sourceChoices(r).map((c) => String(c.id)))
		expect(validSources.has('delay_0_out_0')).toBe(true)
		expect(r.destinations.has('mixer_0_a')).toBe(true)
	})
})

// The write that applies a route is captured by discovery, where the keyword's shape is known, so
// the only thing left to check here is that the destination hands its own write back.
describe('processor destination writers', () => {
	function stateWithInput(write: ProcessorInput['write']): ProcessorState {
		const p = new ProcessorState()
		p.nodeNames.set('gain_0', 'Audio Gain 0')
		p.inputs.set('gain_0_in', {
			id: 'gain_0_in',
			node: 'gain_0',
			suffix: ' In',
			takesChannel: false,
			level: 'audio',
			write,
			sourcePath: null,
			sourceName: null,
			sourceChannel: null,
		})
		return p
	}

	it('routes a processor input through the write discovery built for it', async () => {
		const applied: Array<[unknown, number]> = []
		const p = stateWithInput(async (essence, channel) => void applied.push([essence, channel]))
		const registry = buildRegistry(flowState(chassis(), noRtp(), p))
		const writer = resolveDestinationWriter({} as any, registry, 'gain_0_in', p)
		// Only the level the input carries, so an audio-only input never offers a video write.
		expect(writer?.video).toBeUndefined()
		await writer!.audio!({ kind: 'essence' } as any, 3)
		expect(applied).toEqual([[{ kind: 'essence' }, 3]])
	})

	it('refuses a processor input the device no longer has', () => {
		const p = stateWithInput(async () => undefined)
		const registry = buildRegistry(flowState(chassis(), noRtp(), p))
		p.inputs.delete('gain_0_in')
		expect(resolveDestinationWriter({} as any, registry, 'gain_0_in', p)).toBeNull()
	})
})

// A rename on the device must reach every label built from the node's name, and through them the
// choices and the `src_label_*`/`dst_label_*` variables.
describe('node renames', () => {
	function delayState(): ProcessorState {
		const p = new ProcessorState()
		p.nodeNames.set('delay_0', 'Delay 0')
		p.inputs.set('delay_0_in_0', {
			id: 'delay_0_in_0',
			node: 'delay_0',
			suffix: ' In 0',
			takesChannel: false,
			write: async () => undefined,
			level: 'video',
			sourcePath: null,
			sourceName: null,
			sourceChannel: null,
		})
		p.addOutput({
			id: 'delay_0_out_0',
			node: 'delay_0',
			suffix: ' Out 0',
			level: 'video',
			path: 're_play.video.delays[0].outputs[0].video',
		})
		return p
	}

	it('relabels every input and output on the renamed node', () => {
		const p = delayState()
		p.nodeNames.set('delay_0', 'ISO 1')

		const r = buildRegistry(flowState(chassis(), noRtp(), p))
		expect(r.destinations.get('delay_0_in_0')?.label).toBe('ISO 1 In 0')
		expect(r.sources.get('delay_0_out_0')?.label).toBe('ISO 1 Out 0')
		expect(flowRegistryValues(r)['src_label_delay_0_out_0']).toBe('ISO 1 Out 0')
	})

	it('leaves other nodes alone', () => {
		const p = delayState()
		p.nodeNames.set('mixer_0', 'Mixer 0')
		p.inputs.set('mixer_0_a', {
			id: 'mixer_0_a',
			node: 'mixer_0',
			suffix: ' A',
			takesChannel: false,
			write: async () => undefined,
			level: 'video',
			sourcePath: null,
			sourceName: null,
			sourceChannel: null,
		})
		p.nodeNames.set('delay_0', 'ISO 1')
		expect(buildRegistry(flowState(chassis(), noRtp(), p)).destinations.get('mixer_0_a')?.label).toBe('Mixer 0 A')
	})
})

describe('isSelfLoop', () => {
	const p = new ProcessorState()
	p.inputs.set('mixer_0_a', {
		id: 'mixer_0_a',
		node: 'mixer_0',
		suffix: '',
		takesChannel: false,
		write: async () => undefined,
		level: 'video',
		sourcePath: null,
		sourceName: null,
		sourceChannel: null,
	})
	p.inputs.set('mixer_1_a', {
		id: 'mixer_1_a',
		node: 'mixer_1',
		suffix: '',
		takesChannel: false,
		write: async () => undefined,
		level: 'video',
		sourcePath: null,
		sourceName: null,
		sourceChannel: null,
	})
	p.inputs.set('delay_0_in_0', {
		id: 'delay_0_in_0',
		node: 'delay_0',
		suffix: '',
		takesChannel: false,
		write: async () => undefined,
		level: 'video',
		sourcePath: null,
		sourceName: null,
		sourceChannel: null,
	})
	p.addOutput({
		id: 'mixer_0_out',
		node: 'mixer_0',
		suffix: '',
		level: 'video',
		path: 'video_mixer.instances[0].output',
	})
	p.addOutput({
		id: 'delay_0_out_0',
		node: 'delay_0',
		suffix: '',
		level: 'video',
		path: 're_play.video.delays[0].outputs[0].video',
	})
	const r = buildRegistry(flowState(chassis(), noRtp(), p))

	it('refuses feeding a processor from its own output', () => {
		expect(isSelfLoop(r, 'mixer_0_out', 'mixer_0_a')).toBe(true)
		expect(isSelfLoop(r, 'delay_0_out_0', 'delay_0_in_0')).toBe(true)
	})

	it('allows one processor to feed another', () => {
		expect(isSelfLoop(r, 'mixer_0_out', 'mixer_1_a')).toBe(false)
		expect(isSelfLoop(r, 'delay_0_out_0', 'mixer_0_a')).toBe(false)
	})

	// Plain ports have no node, so they can never trip the guard.
	it('never blocks a route between plain ports', () => {
		expect(isSelfLoop(r, 'sdi_in_0', 'sdi_out_8')).toBe(false)
		expect(isSelfLoop(r, 'sdi_in_0', 'mixer_0_a')).toBe(false)
	})

	// A cycle through two nodes is not caught here; the device reports it as cycle_detected.
	it('does not attempt to catch longer cycles', () => {
		expect(isSelfLoop(r, 'mixer_0_out', 'delay_0_in_0')).toBe(false)
	})
})

// A route from a processor is applied by path, and the tally has to turn that path back into the
// same ID the registry uses - otherwise the route works but reports nothing. Discovery registers
// both halves at once, so the lookup cannot drift from what was registered.
describe('resolving a processor output path', () => {
	const processors = new ProcessorState()
	processors.addOutput({
		id: 'mixer_1_out',
		node: 'mixer_1',
		suffix: ' Output',
		level: 'video',
		path: 'video_mixer.instances[1].output',
	})
	processors.addOutput({
		id: 'audio_delay_1_out_0',
		node: 'audio_delay_1',
		suffix: ' Out 0',
		level: 'audio',
		path: 're_play.audio.delays[1].outputs[0].audio',
	})

	it('maps a registered output path back to its ID', () => {
		expect(sourceIdForPath('video_mixer.instances[1].output', 'video', processors)).toBe('mixer_1_out')
		expect(sourceIdForPath('re_play.audio.delays[1].outputs[0].audio', 'audio', processors)).toBe('audio_delay_1_out_0')
	})

	// An audio path is not a video source, whatever produced it.
	it('resolves an output on its own level only', () => {
		expect(sourceIdForPath('video_mixer.instances[1].output', 'audio', processors)).toBeNull()
		expect(sourceIdForPath('re_play.audio.delays[1].outputs[0].audio', 'video', processors)).toBeNull()
	})

	it('ignores a path no processor produced', () => {
		expect(sourceIdForPath('video_mixer.instances[0].v_src0', 'video', processors)).toBeNull()
	})
})
