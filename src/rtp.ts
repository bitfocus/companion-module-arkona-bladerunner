import type { CompanionVariableDefinition } from '@companion-module/base'
import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import { watchIssues } from './issues.js'
import type { ModuleInstance } from './main.js'
import { activeSourceVariable, sourceIdForPath, type FlowLevel } from './routing.js'
import { watchAll, watchKeyword, watchRowName } from './watch.js'

/** An RTP receiver, which is a routing source. */
export interface RtpReceiverState {
	index: number
	name: string
}

/** An RTP transmitter, which is a routing destination on one or both levels. */
export interface RtpTransmitterState {
	index: number
	name: string
	/** A video streamer carries video; an audio streamer carries only audio. */
	carriesVideo: boolean
	/**
	 * Whether this streamer also carries audio.
	 *
	 * Only ST 2022-6 encapsulates audio inside the video stream. An ST 2110 video flow is video
	 * only - its audio travels as a separate -30 flow on an audio transmitter - and the device
	 * rejects any write to `configuration.a_src` on one.
	 */
	embedsAudio: boolean
	videoSourcePath: string | null
	videoSourceName: string | null
	audioSourcePath: string | null
	audioSourceName: string | null
}

/**
 * The IP side of the routing graph.
 *
 * All four tables are dynamically allocated named tables - this Blade has one video receiver and
 * one video transmitter, and no audio ones at all - so everything here is discovered at connect
 * rather than assumed.
 */
export class RtpState {
	readonly videoReceivers = new Map<number, RtpReceiverState>()
	readonly audioReceivers = new Map<number, RtpReceiverState>()
	readonly videoTransmitters = new Map<number, RtpTransmitterState>()
	readonly audioTransmitters = new Map<number, RtpTransmitterState>()

	clear(): void {
		this.videoReceivers.clear()
		this.audioReceivers.clear()
		this.videoTransmitters.clear()
		this.audioTransmitters.clear()
	}
}

/**
 * A receiver's health, beyond its issues.
 *
 * Error counters accumulate (`err_acc`) and also report a consecutive run, which is what separates
 * "it glitched once an hour ago" from "it is failing right now"; the event counters are cyclic, so
 * they are published as-is and read as "has this changed since I looked".
 */
const RECEIVER_ERROR_COUNTERS = [
	['rx_errors', 'rx_error', 'Receive Errors'],
	['premature_reads', 'premature_read', 'Premature Reads'],
	['liveness_timeouts', 'liveness_timeout', 'Liveness Timeouts'],
	['phase_mismatches', 'phase_mismatch', 'Phase Mismatches'],
] as const

const RECEIVER_EVENT_COUNTERS = [
	['starts_a', 'start_a', 'Stream A Starts'],
	['starts_b', 'start_b', 'Stream B Starts'],
	['switches_ab', 'switch_ab', 'A to B Switches'],
	['switches_ba', 'switch_ba', 'B to A Switches'],
	['stops', 'stop', 'Stops'],
	['restarts', 'restart', 'Restarts'],
] as const

/** Every health variable a receiver publishes, for the definitions and for the watches. */
export function receiverHealthVariables(id: string, label: string): Array<{ variableId: string; name: string }> {
	return [
		...RECEIVER_ERROR_COUNTERS.flatMap(([suffix, , name]) => [
			{ variableId: `${id}_${suffix}`, name: `${label} - ${name}` },
			{ variableId: `${id}_${suffix}_consecutive`, name: `${label} - Consecutive ${name}` },
		]),
		...RECEIVER_EVENT_COUNTERS.map(([suffix, , name]) => ({
			variableId: `${id}_${suffix}`,
			name: `${label} - ${name}`,
		})),
		{ variableId: `${id}_redundancy`, name: `${label} - Streams Present` },
		{ variableId: `${id}_redundancy_required`, name: `${label} - Streams Required` },
		{ variableId: `${id}_latency_spread_ms`, name: `${label} - Latency Spread (ms)` },
	]
}

/** Every RTP health variable this Blade has, from what discovery found. */
export function RtpVariableDefinitions(state: RtpState): CompanionVariableDefinition[] {
	return [
		...[...state.videoReceivers.values()].flatMap((r) => receiverHealthVariables(`rtp_rx_v_${r.index}`, r.name)),
		...[...state.audioReceivers.values()].flatMap((r) => receiverHealthVariables(`rtp_rx_a_${r.index}`, r.name)),
	]
}

export function rtpVideoReceiverPath(index: number): string {
	return `r_t_p_receiver.video_receivers[${index}].media_specific.output.video`
}

export function rtpAudioReceiverPath(index: number): string {
	return `r_t_p_receiver.audio_receivers[${index}].media_specific.output`
}

/** Only the SDI-over-IP encapsulation carries audio inside the video stream. */
export function transportEmbedsAudio(variant: string | null | undefined): boolean {
	return variant === 'ST2022_6'
}

export async function subscribeRtp(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
	const state = self.rtp
	const rx = vm.r_t_p_receiver
	const tx = vm.r_t_p_transmitter
	if (!rx && !tx) {
		self.log('info', 'This Blade has no RTP receiver or transmitter; skipping IP endpoints')
		return
	}

	const batcher = self.variables
	const collect = (w: VScript.Watcher): void => self.connection.track(w)

	// Independent round trips, registered concurrently.
	const pending: Array<Promise<void>> = []

	const [videoRx, audioRx, videoTx, audioTx] = await Promise.all([
		rx ? rx.video_receivers.allocated_indices() : Promise.resolve([]),
		rx ? rx.audio_receivers.allocated_indices() : Promise.resolve([]),
		tx ? tx.video_transmitters.allocated_indices() : Promise.resolve([]),
		tx ? tx.audio_transmitters.allocated_indices() : Promise.resolve([]),
	])

	for (const i of videoRx) {
		state.videoReceivers.set(i, { index: i, name: `RTP Video Rx ${i}` })
		watchReceiverHealth(
			self,
			`rtp_rx_v_${i}`,
			`RTP Video Rx ${i}`,
			rx!.video_receivers.row(i),
			batcher,
			collect,
			pending,
		)
		pending.push(
			watchRowName(
				self,
				`rtp_rx_v_${i}`,
				rx!.video_receivers.row(i),
				`RTP Video Rx ${i}`,
				(name) => {
					state.videoReceivers.get(i)!.name = name
					self.issues.relabel(`rtp_rx_v_${i}`, name)
				},
				collect,
			),
		)
	}
	for (const i of audioRx) {
		state.audioReceivers.set(i, { index: i, name: `RTP Audio Rx ${i}` })
		watchReceiverHealth(
			self,
			`rtp_rx_a_${i}`,
			`RTP Audio Rx ${i}`,
			rx!.audio_receivers.row(i),
			batcher,
			collect,
			pending,
		)
		pending.push(
			watchRowName(
				self,
				`rtp_rx_a_${i}`,
				rx!.audio_receivers.row(i),
				`RTP Audio Rx ${i}`,
				(name) => {
					state.audioReceivers.get(i)!.name = name
					self.issues.relabel(`rtp_rx_a_${i}`, name)
				},
				collect,
			),
		)
	}

	// Read once at discovery: changing a stream's transport format is a reconfiguration, not something
	// that happens under a running show. Independent round trips, so read for every transmitter at once.
	const videoTxVariants = await Promise.all(
		videoTx.map(async (i) => {
			try {
				return (await tx!.video_transmitters.row(i).configuration.transport_format.status.read())?.variant ?? null
			} catch (e: any) {
				self.log('debug', `Could not read transport format for video tx ${i}: ${e?.message ?? e}`)
				return null
			}
		}),
	)

	for (const [txIndex, i] of videoTx.entries()) {
		const row = tx!.video_transmitters.row(i)
		const variant = videoTxVariants[txIndex]

		const entry: RtpTransmitterState = {
			index: i,
			name: `RTP Video Tx ${i}`,
			carriesVideo: true,
			embedsAudio: transportEmbedsAudio(variant),
			videoSourcePath: null,
			videoSourceName: null,
			audioSourcePath: null,
			audioSourceName: null,
		}
		state.videoTransmitters.set(i, entry)
		pending.push(
			watchRowName(
				self,
				`rtp_tx_v_${i}`,
				row,
				`RTP Video Tx ${i}`,
				(name) => {
					entry.name = name
					self.issues.relabel(`rtp_tx_v_${i}`, name)
				},
				collect,
			),
		)
		pending.push(watchIssues(self, `rtp_tx_v_${i}`, `RTP Video Tx ${i}`, row.generic.issues, collect))
		pending.push(watchTally(self, `rtp_tx_v_${i}`, 'video', row.v_src.status, entry, batcher, collect))
		// Only worth watching where the format actually carries audio.
		if (entry.embedsAudio) {
			pending.push(watchTally(self, `rtp_tx_v_${i}`, 'audio', row.configuration.a_src.status, entry, batcher, collect))
		}
	}

	for (const i of audioTx) {
		const row = tx!.audio_transmitters.row(i)
		const entry: RtpTransmitterState = {
			index: i,
			name: `RTP Audio Tx ${i}`,
			carriesVideo: false,
			embedsAudio: true,
			videoSourcePath: null,
			videoSourceName: null,
			audioSourcePath: null,
			audioSourceName: null,
		}
		state.audioTransmitters.set(i, entry)
		pending.push(
			watchRowName(
				self,
				`rtp_tx_a_${i}`,
				row,
				`RTP Audio Tx ${i}`,
				(name) => {
					entry.name = name
					self.issues.relabel(`rtp_tx_a_${i}`, name)
				},
				collect,
			),
		)
		pending.push(watchIssues(self, `rtp_tx_a_${i}`, `RTP Audio Tx ${i}`, row.generic.issues, collect))
		pending.push(watchTally(self, `rtp_tx_a_${i}`, 'audio', row.a_src.status, entry, batcher, collect))
	}

	await watchAll(pending)
	self.log(
		'info',
		`RTP endpoints: ${videoRx.length} video rx, ${audioRx.length} audio rx, ${videoTx.length} video tx, ${audioTx.length} audio tx`,
	)
}

/**
 * Subscribe a receiver's counters, redundancy and latency spread.
 *
 * These are the numbers that say whether a 2110 feed is actually healthy, as opposed to merely
 * routed, so they are variables rather than anything the module reasons about.
 */
function watchReceiverHealth(
	self: ModuleInstance,
	id: string,
	label: string,
	receiver: any,
	batcher: ModuleInstance['variables'],
	collect: (w: VScript.Watcher) => void,
	pending: Array<Promise<void>>,
): void {
	const generic = receiver.generic
	pending.push(watchIssues(self, id, label, generic.issues, collect))

	for (const [suffix, keyword] of RECEIVER_ERROR_COUNTERS) {
		pending.push(
			watchKeyword(
				self,
				`${id}.${keyword}`,
				generic.error_counters[keyword],
				(v: any) => {
					batcher.set(`${id}_${suffix}`, v?.err_acc ?? 0)
					batcher.set(`${id}_${suffix}_consecutive`, v?.consec_err_count ?? 0)
				},
				collect,
			),
		)
	}

	for (const [suffix, keyword] of RECEIVER_EVENT_COUNTERS) {
		pending.push(
			watchKeyword(
				self,
				`${id}.${keyword}`,
				generic.event_counters[keyword],
				(v: any) => {
					batcher.set(`${id}_${suffix}`, Number(v ?? 0))
				},
				collect,
			),
		)
	}

	// How many of the SDP's streams are actually arriving, against how many are demanded - a 2022-7
	// feed running on one leg is healthy until the other leg is needed.
	pending.push(
		watchKeyword(
			self,
			`${id}.redundancy`,
			generic.redundancy_levels.nominally_present.overall,
			(v: any) => {
				batcher.set(`${id}_redundancy`, Number(v ?? 0))
			},
			collect,
		),
	)
	// Required at track A and B separately - a 2022-7 receiver demands one from each.
	pending.push(
		watchKeyword(
			self,
			`${id}.required_redundancy`,
			generic.required_redundancy_level,
			(v: any) => {
				batcher.set(`${id}_redundancy_required`, `${Number(v?.sdp_a ?? 0)}/${Number(v?.sdp_b ?? 0)}`)
			},
			collect,
		),
	)
	pending.push(
		watchKeyword(
			self,
			`${id}.latency_spread`,
			generic.latency_spread.overall,
			(v: any) => {
				batcher.set(`${id}_latency_spread_ms`, v == null ? '' : v.ms().toFixed(3))
			},
			collect,
		),
	)
}

/**
 * Publish a transmitter's routed source for one level.
 *
 * Both RTP `v_src` and `a_src` are TimedSource keywords, exactly like an SDI output's, so the tally
 * shape here matches the SDI one.
 */
async function watchTally(
	self: ModuleInstance,
	destination: string,
	level: FlowLevel,
	keyword: Parameters<typeof watchKeyword>[2],
	entry: RtpTransmitterState,
	batcher: ModuleInstance['variables'],
	collect: (w: VScript.Watcher) => void,
): Promise<void> {
	await watchKeyword(
		self,
		`${destination}.${level}_src`,
		keyword,
		(v: any) => {
			const source = v?.source ?? null
			const path = source ? String(source.raw.kwl) : null
			if (level === 'video') entry.videoSourcePath = path
			else entry.audioSourcePath = path

			const variable = activeSourceVariable(destination, level)
			batcher.set(variable, sourceIdForPath(path, level, self.processors) ?? '')
			if (entry.carriesVideo && entry.embedsAudio) {
				batcher.set(
					`dest_${destination}_breakaway`,
					String(
						sourceIdForPath(entry.videoSourcePath, 'video', self.processors) !==
							sourceIdForPath(entry.audioSourcePath, 'audio', self.processors),
					),
				)
			}
			self.checkFeedbacks('flow_routed', 'flow_breakaway')

			if (!source) {
				if (level === 'video') entry.videoSourceName = null
				else entry.audioSourceName = null
				batcher.set(`${variable}_label`, '')
				return
			}
			void source.brief
				.read()
				.then((brief: string) => {
					if (level === 'video') entry.videoSourceName = brief
					else entry.audioSourceName = brief
					batcher.set(`${variable}_label`, brief)
				})
				.catch(() => batcher.set(`${variable}_label`, path ?? ''))
		},
		collect,
	)
}
