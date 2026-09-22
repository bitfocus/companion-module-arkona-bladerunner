import type { CompanionInputFieldNumber, CompanionVariableDefinition, DropdownChoice } from '@companion-module/base'
import type * as VAPI from 'vapi'
import type { IoState } from './io.js'
import type { ProcessorState } from './processors.js'
import { rtpAudioReceiverPath, rtpVideoReceiverPath, type RtpState } from './rtp.js'

/**
 * Choice offered for "no source", which clears a destination rather than routing to it.
 *
 * Not a port ID, so it can never collide with one.
 */
export const NO_SOURCE = ''

/**
 * Routing levels.
 *
 * An SDI port carries video and audio as separate essences, and the Blade routes them
 * independently: `output[n].sdi.v_src` and `output[n].a_src` can name different sources, which is
 * a breakaway. This is the router spec's level-to-level model - the same source and destination
 * IDs appear on every level.
 */
export type FlowLevel = 'video' | 'audio'

export const FLOW_LEVELS: readonly FlowLevel[] = ['video', 'audio']

/** What a route action may be asked to move: one level, or both together. */
export type RouteLevelOption = FlowLevel | 'both'

export const ROUTE_LEVEL_CHOICES: DropdownChoice[] = [
	{ id: 'both', label: 'Video + Audio' },
	{ id: 'video', label: 'Video only' },
	{ id: 'audio', label: 'Audio only' },
]

/** Which levels a route option actually touches. */
export function levelsForOption(option: string): FlowLevel[] {
	if (option === 'video' || option === 'audio') return [option]
	return [...FLOW_LEVELS]
}

const SDI_INPUT_PREFIX = 'sdi_in_'
const SDI_OUTPUT_PREFIX = 'sdi_out_'

/**
 * The essence paths of a physical SDI input, one per level.
 *
 * Both hang off the same base, which is why one source ID addresses both levels.
 */
const SDI_INPUT_PATH: Record<FlowLevel, RegExp> = {
	video: /^i_o_module\.input\[(\d+)\]\.sdi\.output\.video$/,
	audio: /^i_o_module\.input\[(\d+)\]\.sdi\.output\.audio$/,
}

/**
 * A routable port.
 *
 * `kind` and the ID prefix are the extension points: RTP receivers, mixer outputs and processors
 * become further kinds with their own prefixes, without renumbering anything that exists.
 */
/** Where a routable port comes from. New kinds extend this without disturbing existing IDs. */
export type FlowKind = 'sdi' | 'video_generator' | 'audio_generator' | 'rtp_receiver' | 'rtp_transmitter' | 'processor'

/**
 * Everything the registry is projected from.
 *
 * Grouped rather than passed as separate arguments so adding another source of endpoints does not
 * change the signature again. `ModuleInstance` satisfies this structurally.
 */
export interface FlowStateSources {
	io: IoState
	rtp: RtpState
	processors: ProcessorState
}

export interface FlowPort {
	id: string
	label: string
	/**
	 * The vapi keyword path of the essence this port names.
	 *
	 * Sources are resolved by reviving the essence from this path rather than by walking vapi
	 * accessors, which keeps every source kind uniform - and is the only thing that works for the
	 * audio generator, whose tone essences sit directly at `...signal_400hz` rather than under the
	 * `.output` the typings imply.
	 */
	path: string
	/**
	 * Levels this source can feed. SDI ports carry both; a generator carries one, so routing
	 * "Video + Audio" from a video generator simply has no audio to apply.
	 */
	levels: FlowLevel[]
	kind: FlowKind
	/**
	 * The processing node this endpoint belongs to, or null for a plain port.
	 *
	 * Used to refuse feeding a processor from its own output.
	 */
	node: string | null
}

export interface ActiveSource {
	/** ID of the source on this level, or null. Always a value `route` would accept. */
	sourceId: string | null
	label: string | null
	/** Which channel of that source, where the destination selects one. */
	channel: number | null
}

export interface FlowDestination extends Omit<FlowPort, 'path'> {
	/** BNC number - the device's own stable port identity, never an array position. */
	index: number
	/** Whether a route here selects one channel of the source rather than the whole essence. */
	takesChannel: boolean
	active: Record<FlowLevel, ActiveSource>
}

/** Every level empty, to be spread and then overridden per level a port actually carries. */
function noActiveSources(): Record<FlowLevel, ActiveSource> {
	return {
		video: { sourceId: null, label: null, channel: null },
		audio: { sourceId: null, label: null, channel: null },
	}
}

export interface FlowRegistry {
	sources: Map<string, FlowPort>
	destinations: Map<string, FlowDestination>
}

export function sourceId(index: number): string {
	return `${SDI_INPUT_PREFIX}${index}`
}

export function destinationId(index: number): string {
	return `${SDI_OUTPUT_PREFIX}${index}`
}

/**
 * Map a vapi keyword path back to the source ID that names it, for a given level.
 *
 * The level must match: an audio path is not a video source. Returns null when a destination is
 * fed by something outside the current SDI-only scope - a mixer output, say. That must render as
 * empty rather than be guessed at, or the router would be handed a source ID that its own route
 * action cannot accept.
 */
export function sourceIdForPath(
	path: string | null | undefined,
	level: FlowLevel,
	processors: ProcessorState,
): string | null {
	if (!path) return null
	const sdi = SDI_INPUT_PATH[level].exec(path)
	if (sdi) return sourceId(Number(sdi[1]))

	const rtp = RTP_RECEIVER_PATH[level].exec(path)
	if (rtp) return rtpReceiverId(level, Number(rtp[1]))

	// Processor outputs are looked up in what discovery registered rather than re-derived from the
	// path: a second, hand-written mapping could disagree with discovery, and the only symptom
	// would be a route that applies but tallies as empty.
	const processor = processors.outputsByPath.get(path)
	if (processor?.level === level) return processor.id

	return generatorSources(level).find((g) => g.path === path)?.id ?? null
}

/** RTP receivers keep video and audio in separate tables, unlike an SDI port. */
const RTP_RECEIVER_PATH: Record<FlowLevel, RegExp> = {
	video: /^r_t_p_receiver\.video_receivers\[(\d+)\]\.media_specific\.output\.video$/,
	audio: /^r_t_p_receiver\.audio_receivers\[(\d+)\]\.media_specific\.output$/,
}

export function rtpReceiverId(level: FlowLevel, index: number): string {
	return level === 'video' ? `rtp_rx_v_${index}` : `rtp_rx_a_${index}`
}

export function rtpTransmitterId(carriesVideo: boolean, index: number): string {
	return carriesVideo ? `rtp_tx_v_${index}` : `rtp_tx_a_${index}`
}

/**
 * The signal generators, which are a fixed part of the device rather than something discovered.
 *
 * Audio tones are exposed at 48 kHz only, matching what the Blade's own web UI lists per
 * generator. The 96 kHz set exists on the device and can be added later without disturbing any ID,
 * because the sample rate is already part of the ID.
 */
const AUDIO_GENERATOR_SIGNALS = [
	['1000hz', '1000hz', '1 kHz'],
	['400hz', '400hz', '400 Hz'],
	['440hz', '440hz', '440 Hz'],
	['silence', 'silence', 'Silence'],
] as const

const AUDIO_GENERATOR_COUNT = 3
const AUDIO_GENERATOR_RATE = 'f48000'
const VIDEO_GENERATOR_COUNT = 2

function generatorSources(level: FlowLevel): FlowPort[] {
	if (level === 'video') {
		return Array.from({ length: VIDEO_GENERATOR_COUNT }, (_, i) => ({
			id: `vsg_${i}`,
			label: `Video Signal Generator #${i}`,
			path: `video_signal_generator.instances[${i}].output`,
			levels: ['video'],
			kind: 'video_generator',
			node: null,
		}))
	}

	const sources: FlowPort[] = [
		{
			id: 'asg_alsa_0',
			label: 'ALSA',
			path: 'audio_signal_generator.alsa[0].output',
			levels: ['audio'],
			kind: 'audio_generator',
			node: null,
		},
	]
	// The device labels every genlock instance and sample rate identically, so the label has to be
	// synthesised or the dropdown shows a dozen indistinguishable "Audio Signal Generator [400 Hz]".
	for (let g = 0; g < AUDIO_GENERATOR_COUNT; g++) {
		for (const [key, suffix, label] of AUDIO_GENERATOR_SIGNALS) {
			sources.push({
				id: `asg_g${g}_${AUDIO_GENERATOR_RATE}_${suffix}`,
				label: `Sig Gen ${g} ${AUDIO_GENERATOR_RATE} ${label}`,
				path: `audio_signal_generator.genlock[${g}].${AUDIO_GENERATOR_RATE}.signal_${key}`,
				levels: ['audio'],
				kind: 'audio_generator',
				node: null,
			})
		}
	}
	return sources
}

/** Every generator source, both levels. */
export function allGeneratorSources(): FlowPort[] {
	return [...generatorSources('video'), ...generatorSources('audio')]
}

/** Parse a port ID back to its BNC number, or null if it is not one of ours. */
export function indexForSourceId(id: string): number | null {
	return parseIndex(id, SDI_INPUT_PREFIX)
}

export function indexForDestinationId(id: string): number | null {
	return parseIndex(id, SDI_OUTPUT_PREFIX)
}

function parseIndex(id: string, prefix: string): number | null {
	if (!id.startsWith(prefix)) return null
	const rest = id.slice(prefix.length)
	// Reject `sdi_in_01` and `sdi_in_1x`, so an ID round-trips to exactly one port.
	if (!/^(0|[1-9]\d*)$/.test(rest)) return null
	return Number(rest)
}

/**
 * Project the discovered SDI ports into routable sources and destinations.
 *
 * Derived from `IoState` rather than a second discovery pass - `IoManager` already enumerates the
 * port tables and watches the labels and tallies this needs.
 */
export function buildRegistry({ io, rtp, processors }: FlowStateSources): FlowRegistry {
	const sources = new Map<string, FlowPort>()
	for (const input of io.inputs.values()) {
		sources.set(sourceId(input.index), {
			id: sourceId(input.index),
			label: input.name,
			path: `i_o_module.input[${input.index}].sdi.output.video`,
			// One physical SDI port carries both essences, so one ID addresses both levels.
			levels: ['video', 'audio'],
			kind: 'sdi',
			node: null,
		})
	}
	for (const generator of allGeneratorSources()) sources.set(generator.id, generator)

	// RTP receivers are single-level: video and audio arrive on separate receivers.
	for (const receiver of rtp.videoReceivers.values()) {
		const id = rtpReceiverId('video', receiver.index)
		sources.set(id, {
			id,
			label: receiver.name,
			path: rtpVideoReceiverPath(receiver.index),
			levels: ['video'],
			kind: 'rtp_receiver',
			node: null,
		})
	}
	for (const receiver of rtp.audioReceivers.values()) {
		const id = rtpReceiverId('audio', receiver.index)
		sources.set(id, {
			id,
			label: receiver.name,
			path: rtpAudioReceiverPath(receiver.index),
			levels: ['audio'],
			kind: 'rtp_receiver',
			node: null,
		})
	}

	const destinations = new Map<string, FlowDestination>()
	for (const output of io.outputs.values()) {
		destinations.set(destinationId(output.index), {
			id: destinationId(output.index),
			label: `SDI Output ${output.index}`,
			index: output.index,
			// An SDI output is a destination on both levels: v_src and a_src are independent.
			levels: ['video', 'audio'],
			takesChannel: false,
			kind: 'sdi',
			node: null,
			active: {
				video: {
					sourceId: sourceIdForPath(output.videoSourcePath, 'video', processors),
					// Fall back to the raw path so an out-of-scope source is still visible to a human.
					label: output.videoSourceName ?? output.videoSourcePath ?? null,
					channel: null,
				},
				audio: {
					sourceId: sourceIdForPath(output.audioSourcePath, 'audio', processors),
					label: output.audioSourceName ?? output.audioSourcePath ?? null,
					channel: null,
				},
			},
		})
	}

	// A processor's output is an ordinary source, which is what makes chaining work without any
	// special handling: mixer output -> delay input -> SDI output is three plain routes.
	for (const output of processors.outputs.values()) {
		sources.set(output.id, {
			id: output.id,
			label: processors.label(output),
			path: output.path,
			levels: [output.level],
			kind: 'processor',
			node: output.node,
		})
	}

	// ...and its inputs are ordinary destinations.
	for (const input of processors.inputs.values()) {
		destinations.set(input.id, {
			id: input.id,
			label: processors.label(input),
			index: 0,
			levels: [input.level],
			takesChannel: input.takesChannel,
			kind: 'processor',
			node: input.node,
			active: {
				...noActiveSources(),
				[input.level]: {
					sourceId: sourceIdForPath(input.sourcePath, input.level, processors),
					label: input.sourceName ?? input.sourcePath ?? null,
					channel: input.sourceChannel,
				},
			},
		})
	}

	// RTP transmitters. A video streamer takes both levels (audio via its configuration subtree);
	// an audio streamer takes audio only.
	for (const transmitter of [...rtp.videoTransmitters.values(), ...rtp.audioTransmitters.values()]) {
		const id = rtpTransmitterId(transmitter.carriesVideo, transmitter.index)
		destinations.set(id, {
			id,
			label: transmitter.name,
			index: transmitter.index,
			// An ST 2110 video flow carries no audio, so it is a video-only destination.
			levels: transmitter.carriesVideo ? (transmitter.embedsAudio ? ['video', 'audio'] : ['video']) : ['audio'],
			takesChannel: false,
			kind: 'rtp_transmitter',
			node: null,
			active: {
				video: {
					sourceId: sourceIdForPath(transmitter.videoSourcePath, 'video', processors),
					label: transmitter.videoSourceName ?? transmitter.videoSourcePath ?? null,
					channel: null,
				},
				audio: {
					sourceId: sourceIdForPath(transmitter.audioSourcePath, 'audio', processors),
					label: transmitter.audioSourceName ?? transmitter.audioSourcePath ?? null,
					channel: null,
				},
			},
		})
	}

	return { sources, destinations }
}

/** True when the destination's levels come from different sources - a breakaway. */
export function isBreakaway(destination: FlowDestination | undefined): boolean {
	if (!destination) return false
	// A single-level destination has nothing to break away from.
	if (destination.levels.length < 2) return false
	return destination.active.video.sourceId !== destination.active.audio.sourceId
}

export function sourceChoices(registry: FlowRegistry): DropdownChoice[] {
	return [
		{ id: NO_SOURCE, label: 'None' },
		...[...registry.sources.values()].map((s) => ({
			id: s.id,
			// Single-level sources are marked, so it is obvious why routing one on "Video + Audio"
			// only moves half of it.
			label: s.levels.length === 1 ? `${s.label} [${s.levels[0] === 'video' ? 'Video' : 'Audio'} only]` : s.label,
		})),
	]
}

/**
 * Quote a string as a single-quoted literal for embedding in a Companion expression. The backslash
 * must be escaped before the quote, or an escape the lexer consumes would corrupt the payload.
 */
function expressionString(value: string): string {
	return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/**
 * The "which channel of the source" field, shared by the route action and its feedback so the two
 * cannot disagree about when it applies.
 *
 * It is shown only for the destinations that are fed one channel at a time - an audio shuffler
 * input - which is a property of the registry, so the set is baked into the expression at
 * definition time. `isVisibleExpression` has no equivalent of `isVisibleData`.
 */
export function sourceChannelOption(registry: FlowRegistry): CompanionInputFieldNumber {
	const channelDestinations = [...registry.destinations.values()].filter((d) => d.takesChannel).map((d) => d.id)
	return {
		id: 'source_channel',
		type: 'number',
		label: 'Source Channel',
		tooltip: 'Which audio channel of the source. Only used by destinations fed one channel at a time.',
		default: 0,
		min: 0,
		max: 255,
		isVisibleExpression: `arrayIncludes(jsonparse(${expressionString(JSON.stringify(channelDestinations))}), $(options:destination))`,
	}
}

export function destinationChoices(registry: FlowRegistry): DropdownChoice[] {
	return [...registry.destinations.values()].map((d) => ({ id: d.id, label: d.label }))
}

const LEVEL_LABEL: Record<FlowLevel, string> = { video: 'Video', audio: 'Audio' }

export function FlowVariableDefinitions(registry: FlowRegistry): CompanionVariableDefinition[] {
	return [
		{ variableId: 'flow_source_count', name: 'Flows - Source Count' },
		{ variableId: 'flow_destination_count', name: 'Flows - Destination Count' },
		{ variableId: 'flow_sources', name: 'Flows - Available Source IDs' },
		{ variableId: 'flow_destinations', name: 'Flows - Available Destination IDs' },

		...[...registry.sources.values()].map((s) => ({
			variableId: `src_label_${s.id}`,
			name: `Flows - ${s.label} Label`,
		})),

		...[...registry.destinations.values()].flatMap((d) => [
			{ variableId: `dst_label_${d.id}`, name: `Flows - ${d.label} Label` },
			// Breakaway only exists where there are two levels to break apart.
			...(d.levels.length > 1 ? [{ variableId: `dest_${d.id}_breakaway`, name: `Flows - ${d.label} Breakaway` }] : []),
			// One per (level, destination): the router spec's level-to-level shape. The value is
			// always a source ID the route action accepts. A single-level destination - a video
			// delay input, say - gets only its own level, never a stray audio one.
			...d.levels.flatMap((level) => [
				{
					variableId: activeSourceVariable(d.id, level),
					name: `Flows - ${d.label} ${LEVEL_LABEL[level]} Active Source ID`,
				},
				{
					variableId: `${activeSourceVariable(d.id, level)}_label`,
					name: `Flows - ${d.label} ${LEVEL_LABEL[level]} Active Source`,
				},
				// Only a destination fed one channel at a time has a channel to report.
				...(d.takesChannel
					? [
							{
								variableId: `${activeSourceVariable(d.id, level)}_channel`,
								name: `Flows - ${d.label} ${LEVEL_LABEL[level]} Active Source Channel`,
							},
						]
					: []),
			]),
		]),
	]
}

export function activeSourceVariable(destination: string, level: FlowLevel): string {
	return `dest_${destination}_${level}_active_source`
}

/** Static values that only change when the port layout does. */
export function flowRegistryValues(registry: FlowRegistry): Record<string, string | number> {
	const values: Record<string, string | number> = {
		flow_source_count: registry.sources.size,
		flow_destination_count: registry.destinations.size,
		flow_sources: [...registry.sources.keys()].join(','),
		flow_destinations: [...registry.destinations.keys()].join(','),
	}
	for (const source of registry.sources.values()) values[`src_label_${source.id}`] = source.label
	for (const destination of registry.destinations.values()) {
		values[`dst_label_${destination.id}`] = destination.label
	}
	return values
}

/**
 * Live vapi objects are resolved per call rather than held, so a reconnect cannot leave them stale.
 *
 * Membership is checked against the registry because `table.row(n)` happily returns a row object
 * for an index that does not exist - the failure would otherwise surface much later as a read
 * timeout against a phantom port.
 */
export function resolveSourceEssence(
	registry: FlowRegistry,
	id: string,
	level: 'video',
	revive: EssenceRevival,
): VAPI.AT1130.Video.Essence | null
export function resolveSourceEssence(
	registry: FlowRegistry,
	id: string,
	level: 'audio',
	revive: EssenceRevival,
): VAPI.AT1130.Audio.Essence | null
export function resolveSourceEssence(
	registry: FlowRegistry,
	id: string,
	level: FlowLevel,
	revive: EssenceRevival,
): VAPI.AT1130.Video.Essence | VAPI.AT1130.Audio.Essence | null
export function resolveSourceEssence(
	registry: FlowRegistry,
	id: string,
	level: FlowLevel,
	revive: EssenceRevival,
): VAPI.AT1130.Video.Essence | VAPI.AT1130.Audio.Essence | null {
	const source = registry.sources.get(id)
	if (!source || !source.levels.includes(level)) return null
	// SDI ports name their video essence; the audio one is its sibling.
	const path = source.kind === 'sdi' && level === 'audio' ? source.path.replace(/\.video$/, '.audio') : source.path
	return level === 'video' ? revive(path, 'video') : revive(path, 'audio')
}

/**
 * Revive an essence from its keyword path.
 *
 * Injected rather than imported so the pure routing logic stays testable without a socket.
 */
export interface EssenceRevival {
	(path: string, level: 'video'): VAPI.AT1130.Video.Essence
	(path: string, level: 'audio'): VAPI.AT1130.Audio.Essence
}

export type AnyEssence = VAPI.AT1130.Video.Essence | VAPI.AT1130.Audio.Essence

/**
 * Whether routing `sourceId` into `destinationId` would feed a processor from its own output.
 *
 * Only the obvious self-loop is caught: a longer cycle through two mixers still reaches the device,
 * where it surfaces as `cycle_detected` on the affected time source.
 */
export function isSelfLoop(registry: FlowRegistry, sourceId: string, destinationId: string): boolean {
	const source = registry.sources.get(sourceId)
	const destination = registry.destinations.get(destinationId)
	if (!source?.node || !destination?.node) return false
	return source.node === destination.node
}

/**
 * How to apply a route to one destination, per level. A missing level cannot be routed.
 *
 * `channel` is the channel of the source to take, and matters only where the destination selects
 * one - an audio shuffler. Every other writer takes the whole essence and ignores it.
 */
export type DestinationWriter = Partial<
	Record<FlowLevel, (essence: AnyEssence | null, channel: number) => Promise<void>>
>

/**
 * Build the write for each level a destination supports.
 *
 * Every `v_src`/`a_src` on the device is a TimedSource keyword, so the writes are uniform - the one
 * exception is an SDI output's video, where vapi's `set_video_source` also waits for the output to
 * actually carry the source, and is worth keeping for the verification and its diagnostics.
 */
export function resolveDestinationWriter(
	vm: VAPI.AT1130.Root,
	registry: FlowRegistry,
	id: string,
	processors: ProcessorState,
): DestinationWriter | null {
	const destination = registry.destinations.get(id)
	if (!destination) return null
	const timed = (source: AnyEssence | null) => ({ source, switch_time: null }) as never

	if (destination.kind === 'sdi') {
		if (!vm.i_o_module) return null
		const row = vm.i_o_module.output.row(destination.index)
		return {
			video: async (essence) => row.sdi.set_video_source(essence as VAPI.AT1130.Video.Essence | null),
			audio: async (essence) => row.a_src.command.write(timed(essence)),
		}
	}

	// A processor input carries the write discovery built for it, which is what keeps the shapes
	// that are not a plain demand keyword - a UDX's, a shuffler's - out of this function.
	if (destination.kind === 'processor') {
		const input = processors.inputs.get(destination.id)
		if (!input) return null
		return { [input.level]: input.write }
	}

	if (destination.kind === 'rtp_transmitter') {
		const tx = vm.r_t_p_transmitter
		if (!tx) return null
		if (destination.levels.includes('video')) {
			const row = tx.video_transmitters.row(destination.index)
			const writer: DestinationWriter = {
				video: async (essence) => row.v_src.command.write(timed(essence)),
			}
			// Audio exists on a video streamer only where the transport format embeds it, which the
			// registry has already resolved into the destination's levels. Offering it otherwise would
			// mean every audio route failed at the device instead of being reported as unsupported.
			if (destination.levels.includes('audio')) {
				writer.audio = async (essence) => row.configuration.a_src.command.write(timed(essence))
			}
			return writer
		}
		const row = tx.audio_transmitters.row(destination.index)
		return { audio: async (essence) => row.a_src.command.write(timed(essence)) }
	}

	return null
}
