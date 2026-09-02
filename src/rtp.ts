import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { activeSourceVariable, sourceIdForPath, type FlowLevel } from './routing.js'
import { watchAll, watchKeyword } from './watch.js'

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

/** A transmitter row name is often blank; fall back to something that still identifies the row. */
function endpointName(name: string, fallback: string): string {
	return name.trim() === '' ? fallback : name
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
		await watchRowName(
			self,
			rx!.video_receivers.row(i),
			(name) => {
				state.videoReceivers.get(i)!.name = endpointName(name, `RTP Video Rx ${i}`)
			},
			collect,
		)
	}
	for (const i of audioRx) {
		state.audioReceivers.set(i, { index: i, name: `RTP Audio Rx ${i}` })
		await watchRowName(
			self,
			rx!.audio_receivers.row(i),
			(name) => {
				state.audioReceivers.get(i)!.name = endpointName(name, `RTP Audio Rx ${i}`)
			},
			collect,
		)
	}

	for (const i of videoTx) {
		const row = tx!.video_transmitters.row(i)
		// Read once at discovery: changing a stream's transport format is a reconfiguration, not
		// something that happens under a running show.
		let variant: string | null = null
		try {
			variant = (await row.configuration.transport_format.status.read())?.variant ?? null
		} catch (e: any) {
			self.log('debug', `Could not read transport format for video tx ${i}: ${e?.message ?? e}`)
		}

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
		await watchRowName(
			self,
			row,
			(name) => {
				entry.name = endpointName(name, `RTP Video Tx ${i}`)
			},
			collect,
		)
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
		await watchRowName(
			self,
			row,
			(name) => {
				entry.name = endpointName(name, `RTP Audio Tx ${i}`)
			},
			collect,
		)
		pending.push(watchTally(self, `rtp_tx_a_${i}`, 'audio', row.a_src.status, entry, batcher, collect))
	}

	await watchAll(pending)
	self.log(
		'info',
		`RTP endpoints: ${videoRx.length} video rx, ${audioRx.length} audio rx, ${videoTx.length} video tx, ${audioTx.length} audio tx`,
	)
}

/** Row names are a keyword on named-table rows, so they are read once rather than watched. */
async function watchRowName(
	self: ModuleInstance,
	row: { row_name: () => Promise<string> },
	apply: (name: string) => void,
	_collect: (w: VScript.Watcher) => void,
): Promise<void> {
	try {
		apply(await row.row_name())
	} catch (e: any) {
		self.log('debug', `Could not read RTP row name: ${e?.message ?? e}`)
	}
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
			batcher.set(variable, sourceIdForPath(path, level) ?? '')
			self.checkFeedbacks('flow_routed')

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
