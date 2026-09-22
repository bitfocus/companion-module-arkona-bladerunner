import type * as VAPI from 'vapi'
import type * as VScript from 'vscript'
import { watchIssues } from './issues.js'
import type { ModuleInstance } from './main.js'
import { activeSourceVariable, sourceIdForPath } from './routing.js'
import type { AnyEssence, FlowLevel } from './routing.js'
import { watchAll, watchKeyword, watchRowName, type NamedRow, type Watchable } from './watch.js'

/** How a processor input applies a route. `channel` is used only where the input takes one. */
export type ProcessorWrite = (essence: AnyEssence | null, channel: number) => Promise<void>

/**
 * A processing node - something that both consumes and produces essences.
 *
 * Nothing about routing changes for a processor: its inputs are ordinary destinations and its
 * outputs ordinary sources, so chaining is just two routes. `node` exists so an obviously cyclic
 * route (a node fed from its own output) can be refused.
 */
export interface ProcessorInput {
	id: string
	node: string
	/** What follows the node's name in the label, so a rename relabels the whole node. */
	suffix: string
	/**
	 * Whether this input takes one channel of a source rather than the whole essence.
	 *
	 * An audio shuffler is fed per channel - its reference names `<essence>.channels[n]` - which is
	 * why the device's own UI offers an SDI port's 32 channels here and one entry everywhere else.
	 */
	takesChannel: boolean
	/** Processors are single-level: a video delay takes video, an audio delay takes audio. */
	level: FlowLevel
	/**
	 * How a route is applied here, captured while discovery holds the keyword.
	 *
	 * Deriving this from the ID at write time would mean a second, hand-maintained copy of every
	 * processor's shape, which can disagree with discovery without anything failing to compile.
	 */
	write: ProcessorWrite
	/** The keyword that names the routed essence. Written as a bare reference, not a TimedSource. */
	sourcePath: string | null
	sourceName: string | null
	/** Which channel of the source feeds this input, where the input selects one. */
	sourceChannel: number | null
}

export interface ProcessorOutput {
	id: string
	node: string
	suffix: string
	level: FlowLevel
	path: string
}

/** Live values needed by mixer actions and synchronous Companion feedback callbacks. */
export interface VideoMixerState {
	index: number
	mode: VAPI.VideoMixer.BSLKMode | null
	fader0: number | null
	fader1: number | null
	clip: number | null
	gain: number | null
	opacity: number | null
	invert: boolean | null
}

export class ProcessorState {
	readonly inputs = new Map<string, ProcessorInput>()
	readonly outputs = new Map<string, ProcessorOutput>()
	/** Outputs by the keyword path they produce, which is how a tally resolves back to a source ID. */
	readonly outputsByPath = new Map<string, ProcessorOutput>()
	/** The current name of each node, which every label on it is built from. */
	readonly nodeNames = new Map<string, string>()
	readonly videoMixers = new Map<number, VideoMixerState>()

	videoMixerChoices(): Array<{ id: number; label: string }> {
		return [...this.videoMixers.values()].map((m) => ({
			id: m.index,
			label: this.nodeNames.get(mixerNode(m.index)) ?? `Mixer ${m.index}`,
		}))
	}

	addOutput(output: ProcessorOutput): void {
		this.outputs.set(output.id, output)
		this.outputsByPath.set(output.path, output)
	}

	/** A port's label: its node's current name plus what the port is called on that node. */
	label(port: ProcessorInput | ProcessorOutput): string {
		return `${this.nodeNames.get(port.node) ?? port.node}${port.suffix}`
	}

	clear(): void {
		this.inputs.clear()
		this.outputs.clear()
		this.outputsByPath.clear()
		this.nodeNames.clear()
		this.videoMixers.clear()
	}
}

export function mixerNode(index: number): string {
	return `mixer_${index}`
}

export function delayNode(index: number): string {
	return `delay_${index}`
}

export function audioDelayNode(index: number): string {
	return `audio_delay_${index}`
}

/**
 * The part of a vscript subtree this module reads directly.
 *
 * vapi's typed accessors assert the container type they were generated against - a child that is a
 * table in one firmware and an array in another throws on property access, which took the whole of
 * discovery down. Enumerating from the schema the device actually sent avoids that assertion.
 */
interface RawSubtree {
	kwl: string
	backing_store: { table_indices: (opts: { table_kwl: unknown }) => Promise<number[]> }
	description: { children?: Array<Record<string, any>> }
}

/** Descriptions nest their kernel under `contents`, however many wrappers deep. */
function childKernel(child: Record<string, any>): Record<string, any> {
	let kernel = child
	while (kernel.contents) kernel = kernel.contents
	return kernel
}

/**
 * The allocated indices of a child table, or every index of a child array.
 *
 * Returns an empty list when the device has no such child, so a processor shape this firmware does
 * not have costs nothing.
 */
export async function childIndices(self: ModuleInstance, raw: RawSubtree, name: string): Promise<number[]> {
	const child = (raw.description.children ?? []).find((c) => childKernel(c).sys_name === name)
	if (!child) return []
	// 1 = table (named or not), 2 = array; anything else holds no rows.
	if (child.container_type === 2) return Array.from({ length: Number(child.capacity ?? 0) }, (_, i) => i)
	if (child.container_type !== 1) return []
	try {
		return await raw.backing_store.table_indices({ table_kwl: `${raw.kwl}.${name}` })
	} catch (e: any) {
		self.log('debug', `Could not enumerate ${raw.kwl}.${name}: ${e?.message ?? e}`)
		return []
	}
}

/** A demand/status keyword pair, which is what most processor inputs are. */
interface DemandKeyword {
	status: Watchable<unknown>
	command: { write: (essence: never) => Promise<void> }
}

/** A reference held as one plain read/write keyword instead - a UDX output's video source. */
interface PlainKeyword {
	watch: Watchable<unknown>['watch']
	write: (essence: never) => Promise<void>
}

/** Where an input's current reference is read from, and how a new one is applied. */
interface InputKeyword {
	watch: Watchable<unknown>
	write: ProcessorWrite
}

function demand(keyword: DemandKeyword): InputKeyword {
	return { watch: keyword.status, write: async (essence) => keyword.command.write(essence as never) }
}

function plain(keyword: PlainKeyword): InputKeyword {
	return { watch: keyword, write: async (essence) => keyword.write(essence as never) }
}

/**
 * Discover every processor input and output, and keep the input tallies up to date.
 *
 * All of these are the "direct essence reference" shape, unlike SDI and RTP endpoints which take a
 * TimedSource - see `resolveDestinationWriter`.
 */
export async function subscribeProcessors(self: ModuleInstance, vm: VAPI.AT1130.Root): Promise<void> {
	const state = self.processors
	const batcher = self.variables
	const collect = (w: VScript.Watcher): void => self.connection.track(w)

	// Each subscription is an independent round trip, so they are registered concurrently.
	const pending: Array<Promise<void>> = []
	/** Register an input and return the tally handler that publishes what it is fed from. */
	const createInput = (
		id: string,
		suffix: string,
		node: string,
		level: FlowLevel,
		write: ProcessorWrite,
		takesChannel = false,
	): ((v: any) => void) => {
		const entry: ProcessorInput = {
			id,
			node,
			suffix,
			takesChannel,
			level,
			write,
			sourcePath: null,
			sourceName: null,
			sourceChannel: null,
		}
		state.inputs.set(id, entry)
		return (raw: any) => {
			// A direct reference resolves straight to the essence, with no TimedSource wrapper. A
			// channel reference wraps one - `enclosing_subtree` is the essence, `index` the channel.
			const channel: number | null = raw?.enclosing_subtree ? Number(raw.index) : null
			const v = raw?.enclosing_subtree ?? raw
			const path = v ? String(v.raw.kwl) : null
			entry.sourcePath = path
			entry.sourceChannel = channel
			const variable = activeSourceVariable(id, level)
			batcher.set(variable, sourceIdForPath(path, level, state) ?? '')
			if (takesChannel) batcher.set(`${variable}_channel`, channel ?? '')
			self.checkFeedbacks('flow_routed')

			if (!v) {
				entry.sourceName = null
				batcher.set(`${variable}_label`, '')
				return
			}
			const withChannel = (name: string): string => (channel === null ? name : `${name} ch ${channel}`)
			void v.brief
				.read()
				.then((brief: string) => {
					entry.sourceName = withChannel(brief)
					batcher.set(`${variable}_label`, entry.sourceName ?? '')
				})
				.catch(() => batcher.set(`${variable}_label`, withChannel(path ?? '')))
		}
	}

	const addInput = (id: string, suffix: string, node: string, level: FlowLevel, keyword: InputKeyword): void => {
		const publish = createInput(id, suffix, node, level, keyword.write)
		pending.push(watchKeyword(self, `${id}.src`, keyword.watch, publish, collect))
	}

	/**
	 * A shuffler's inputs, which share one keyword holding an array of references.
	 *
	 * Each element references one channel of a source essence rather than the essence itself, and
	 * is written as a sparse array so the other channels keep what they had.
	 */
	const addShufflerInputs = (
		node: string,
		level: FlowLevel,
		channels: number,
		keyword: { status: Watchable<unknown>; command: { write: (refs: never) => Promise<void> } },
		channelRef: (essence: AnyEssence, channel: number) => unknown,
	): void => {
		const publishers = Array.from({ length: channels }, (_, j) =>
			createInput(
				`${node}_in_${j}`,
				` In ${j}`,
				node,
				level,
				async (essence, channel) => {
					await keyword.command.write({ [j]: essence === null ? null : channelRef(essence, channel) } as never)
				},
				true,
			),
		)
		pending.push(
			watchKeyword(
				self,
				`${node}.src[]`,
				keyword.status,
				(v: any) => {
					const refs: any[] = Array.isArray(v) ? v : []
					publishers.forEach((publish, j) => publish(refs[j] ?? null))
				},
				collect,
			),
		)
	}

	/**
	 * Track a node's name.
	 *
	 * The name is set from the fallback first so labels exist synchronously, then watched: renaming
	 * a delay in the device's web UI has to reach the choices and the label variables, not wait for
	 * the next reconnect. A node that is not a table row keeps its fallback for good.
	 */
	const nameNode = (node: string, fallback: string, row: NamedRow | null): void => {
		state.nodeNames.set(node, fallback)
		if (row) {
			pending.push(
				watchRowName(
					self,
					node,
					row,
					fallback,
					(name) => {
						state.nodeNames.set(node, name)
						self.issues.relabel(node, name)
					},
					collect,
				),
			)
		}
	}

	/**
	 * Follow a node's own health report, where it has one.
	 *
	 * Not every processor carries `issues` - a splitter and a shuffler do not - so this is called
	 * only where the keyword exists rather than probed for.
	 */
	const nodeIssues = (node: string, keyword: Watchable<unknown>): void => {
		pending.push(watchIssues(self, node, state.nodeNames.get(node) ?? node, keyword, collect))
	}

	/**
	 * Run one processor type's discovery, keeping a firmware mismatch to that type.
	 *
	 * The device's schema is not guaranteed to match the shape vapi was generated against, and a
	 * processor this module gets wrong must not cost every other processor its routing.
	 */
	const discover = async (what: string, fn: () => Promise<void>): Promise<void> => {
		try {
			await fn()
		} catch (e: any) {
			self.log('warn', `Skipping ${what}: ${e?.message ?? e}`)
		}
	}

	const addOutput = (id: string, suffix: string, node: string, level: FlowLevel, path: string): void => {
		state.addOutput({ id, node, suffix, level, path })
	}

	// Each type is independent, and each is several round trips, so they are discovered together.
	await Promise.all([
		discover('video mixers', async () => {
			const mixer = vm.video_mixer
			if (!mixer) return
			for (const i of await mixer.instances.allocated_indices()) {
				const row = mixer.instances.row(i)
				const node = mixerNode(i)
				const live: VideoMixerState = {
					index: i,
					mode: null,
					fader0: null,
					fader1: null,
					clip: null,
					gain: null,
					opacity: null,
					invert: null,
				}
				state.videoMixers.set(i, live)
				nameNode(node, `Mixer ${i}`, row)
				nodeIssues(node, row.issues)
				addInput(`${node}_a`, ' A', node, 'video', demand(row.v_src0))
				addInput(`${node}_b`, ' B', node, 'video', demand(row.v_src1))
				addInput(`${node}_key`, ' Key', node, 'video', demand(row.luma_keyer.v_src))
				addOutput(`${node}_out`, ' Output', node, 'video', `video_mixer.instances[${i}].output`)
				pending.push(
					watchKeyword(
						self,
						`${node}.mode`,
						row.mode,
						(v) => {
							live.mode = v
							self.checkFeedbacks('video_mixer_mode')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.fader0`,
						row.mixer.fader0.current,
						(v) => {
							live.fader0 = Number(v)
							self.checkFeedbacks('video_mixer_fader', 'video_mixer_input')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.fader1`,
						row.mixer.fader1.current,
						(v) => {
							live.fader1 = Number(v)
							self.checkFeedbacks('video_mixer_fader')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.clip`,
						row.luma_keyer.clip,
						(v) => {
							live.clip = Number(v)
							self.checkFeedbacks('video_mixer_luma_value')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.gain`,
						row.luma_keyer.gain,
						(v) => {
							live.gain = Number(v)
							self.checkFeedbacks('video_mixer_luma_value')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.opacity`,
						row.luma_keyer.opacity.current,
						(v) => {
							live.opacity = Number(v)
							self.checkFeedbacks('video_mixer_key_opacity', 'video_mixer_key_visible')
						},
						collect,
					),
					watchKeyword(
						self,
						`${node}.invert`,
						row.luma_keyer.invert,
						(v) => {
							live.invert = Boolean(v)
							self.checkFeedbacks('video_mixer_key_inverted')
						},
						collect,
					),
				)
			}
		}),

		discover('video re-play', async () => {
			const replay = vm.re_play?.video
			if (!replay) return
			for (const i of await replay.delays.allocated_indices()) {
				const row = replay.delays.row(i)
				const node = delayNode(i)
				nameNode(node, `Delay ${i}`, row)
				nodeIssues(node, row.issues)
				// Inputs and outputs are separate tables on a delay, so they are indexed independently.
				const [inputs, outputs] = await Promise.all([
					childIndices(self, row.raw as RawSubtree, 'inputs'),
					childIndices(self, row.raw as RawSubtree, 'outputs'),
				])
				for (const j of inputs) {
					addInput(`${node}_in_${j}`, ` In ${j}`, node, 'video', demand(row.inputs.row(j).v_src))
				}
				for (const k of outputs) {
					addOutput(`${node}_out_${k}`, ` Out ${k}`, node, 'video', `re_play.video.delays[${i}].outputs[${k}].video`)
				}
			}

			for (const i of await replay.players.allocated_indices()) {
				const node = `player_${i}`
				const player = replay.players.row(i)
				nameNode(node, `Player ${i}`, player)
				nodeIssues(node, player.issues)
				addOutput(`${node}_out`, ' Output', node, 'video', `re_play.video.players[${i}].output.video`)
			}
		}),

		discover('audio re-play', async () => {
			const audioReplay = vm.re_play?.audio
			if (!audioReplay) return
			for (const i of await audioReplay.delays.allocated_indices()) {
				const row = audioReplay.delays.row(i)
				const node = audioDelayNode(i)
				nameNode(node, `Audio Delay ${i}`, row)
				nodeIssues(node, row.issues)
				// An audio delay has a single input subtree rather than a table of them.
				addInput(`${node}_in`, ' In', node, 'audio', demand(row.inputs.a_src))
				for (const k of await childIndices(self, row.raw as RawSubtree, 'outputs')) {
					addOutput(`${node}_out_${k}`, ` Out ${k}`, node, 'audio', `re_play.audio.delays[${i}].outputs[${k}].audio`)
				}
			}

			for (const i of await audioReplay.players.allocated_indices()) {
				const node = `audio_player_${i}`
				const player = audioReplay.players.row(i)
				nameNode(node, `Audio Player ${i}`, player)
				nodeIssues(node, player.issues)
				addOutput(`${node}_out`, ' Output', node, 'audio', `re_play.audio.players[${i}].output.audio`)
			}
		}),

		// Colour correctors are one video in, one video out, in two independent tables.
		discover('colour correction', async () => {
			const cc = vm.color_correction
			if (!cc) return
			for (const [table, prefix, label] of [
				[cc.cc1d, 'cc1d', '1D Colour Correction'],
				[cc.cc3d, 'cc3d', '3D Colour Correction'],
			] as const) {
				for (const i of await table.allocated_indices()) {
					const row = table.row(i)
					const node = `${prefix}_${i}`
					nameNode(node, `${label} ${i}`, row)
					nodeIssues(node, row.issues)
					addInput(`${node}_in`, ' In', node, 'video', demand(row.v_src))
					addOutput(`${node}_out`, ' Out', node, 'video', `color_correction.${prefix}[${i}].output`)
				}
			}
		}),

		// A splitter fans one video source out to several identical outputs.
		discover('splitters', async () => {
			const splitter = vm.splitter
			if (!splitter) return
			for (const i of await splitter.instances.allocated_indices()) {
				const row = splitter.instances.row(i)
				const node = `splitter_${i}`
				nameNode(node, `Splitter ${i}`, row)
				addInput(`${node}_in`, ' In', node, 'video', demand(row.v_src))
				for (const k of await childIndices(self, row.raw as RawSubtree, 'outputs')) {
					addOutput(`${node}_out_${k}`, ` Out ${k}`, node, 'video', `splitter.instances[${i}].outputs[${k}].output`)
				}
			}
		}),

		// Each UDX output is its own converter: one video in, one converted video out. The rows are a
		// plain table rather than a named one, so there is no name to follow.
		discover('UDX converters', async () => {
			const udx = vm.u_d_x
			if (!udx) return
			for (const k of await udx.outputs.allocated_indices()) {
				const node = `udx_${k}`
				nameNode(node, `UDX ${k}`, null)
				addInput(`${node}_in`, ' In', node, 'video', plain(udx.outputs.row(k).video_source))
				addOutput(`${node}_out`, ' Out', node, 'video', `u_d_x.outputs[${k}].signal`)
			}
		}),

		// A multiviewer head produces video and takes its inputs as monitoring objects rather than as
		// routed essences, so only its output belongs in the graph.
		discover('multiviewer outputs', async () => {
			const mvIo = vm.multiviewer_i_o
			if (!mvIo) return
			// A fixed-size array rather than an allocatable table, so every head is always present.
			for (let k = 0; k < mvIo.outputs.size; k++) {
				const node = `mv_${k}`
				nameNode(node, `Multiviewer Head ${k}`, null)
				addOutput(`${node}_out`, ' Out', node, 'video', `multiviewer_i_o.outputs[${k}]`)
			}
		}),

		discover('audio gain', async () => {
			const gain = vm.audio_gain
			if (!gain) return
			for (const i of await gain.instances.allocated_indices()) {
				const row = gain.instances.row(i)
				const node = `gain_${i}`
				nameNode(node, `Audio Gain ${i}`, row)
				addInput(`${node}_in`, ' In', node, 'audio', demand(row.a_src))
				addOutput(`${node}_out`, ' Out', node, 'audio', `audio_gain.instances[${i}].output`)
			}
		}),

		discover('sample rate converters', async () => {
			const src = vm.sample_rate_converter
			if (!src) return
			for (const i of await src.instances.allocated_indices()) {
				const row = src.instances.row(i)
				const node = `src_${i}`
				nameNode(node, `Sample Rate Converter ${i}`, row)
				addInput(`${node}_in`, ' In', node, 'audio', demand(row.a_src))
				addOutput(`${node}_out`, ' Out', node, 'audio', `sample_rate_converter.instances[${i}].output`)
			}
		}),

		// A shuffler takes one reference per output channel, all in a single array keyword.
		discover('audio shufflers', async () => {
			const shuffler = vm.audio_shuffler
			if (!shuffler) return
			const indices = await shuffler.instances.allocated_indices()
			const rows = indices.map((i) => shuffler.instances.row(i))
			// The array's own length is what says how many channels each shuffler has; inventing a count
			// would invent destinations whose writes the device has nowhere to put. Independent round
			// trips, so read every shuffler's channel count at once.
			const currents = await Promise.all(rows.map(async (row) => row.a_src.status.read()))
			indices.forEach((i, index) => {
				const row = rows[index]
				const node = `shuffler_${i}`
				nameNode(node, `Audio Shuffler ${i}`, row)
				const channels = Array.isArray(currents[index]) ? currents[index].length : 0
				if (channels === 0) self.log('warn', `Audio shuffler ${i} reports no channels; it cannot be routed`)
				addShufflerInputs(node, 'audio', channels, row.a_src, (essence, channel) =>
					(essence as VAPI.AT1130.Audio.Essence).channels.reference_to_index(channel),
				)
				addOutput(`${node}_out`, ' Out', node, 'audio', `audio_shuffler.instances[${i}].output`)
			})
		}),

		// An audio mixer's channels are its destinations: each one is an independent reference, and the
		// mix itself is the single output.
		discover('audio mixers', async () => {
			const audioMixer = vm.audio_mixer
			if (!audioMixer) return
			for (const i of await audioMixer.mono_mixes.allocated_indices()) {
				const row = audioMixer.mono_mixes.row(i)
				const node = `amix_mono_${i}`
				nameNode(node, `Mono Mix ${i}`, row)
				for (const j of await childIndices(self, row.raw as RawSubtree, 'channels')) {
					addInput(`${node}_ch_${j}`, ` Ch ${j}`, node, 'audio', demand(row.channels.row(j).source.a_src))
				}
				addOutput(`${node}_out`, ' Out', node, 'audio', `audio_mixer.mono_mixes[${i}].output`)
			}
			for (const i of await audioMixer.stereo_mixes.allocated_indices()) {
				const row = audioMixer.stereo_mixes.row(i)
				const node = `amix_stereo_${i}`
				nameNode(node, `Stereo Mix ${i}`, row)
				// Mono channels and stereo pairs are separate tables, indexed independently.
				const [monos, pairs] = await Promise.all([
					childIndices(self, row.raw as RawSubtree, 'mono_channels'),
					childIndices(self, row.raw as RawSubtree, 'stereo_pairs'),
				])
				for (const j of monos) {
					addInput(`${node}_mono_${j}`, ` Mono ${j}`, node, 'audio', demand(row.mono_channels.row(j).source.a_src))
				}
				for (const j of pairs) {
					addInput(`${node}_pair_${j}`, ` Pair ${j}`, node, 'audio', demand(row.stereo_pairs.row(j).source.a_src))
				}
				addOutput(`${node}_out`, ' Out', node, 'audio', `audio_mixer.stereo_mixes[${i}].output.output`)
			}
		}),

		// The monitoring live view consumes video but produces nothing, so it is a destination only,
		// as are the audio analysers.
		discover('monitoring', async () => {
			const monitoring = vm.monitoring
			if (!monitoring) return
			nameNode('monitor', 'Monitoring Live View', null)
			addInput('monitor_live', '', 'monitor', 'video', demand(monitoring.live_view.v_src))

			for (const [table, prefix, label] of [
				[monitoring.loudness, 'loudness', 'Loudness Monitor'],
				[monitoring.correlation, 'correlation', 'Phase Correlation'],
			] as const) {
				for (const i of await table.allocated_indices()) {
					const row = table.row(i)
					const node = `${prefix}_${i}`
					nameNode(node, `${label} ${i}`, row)
					addInput(`${node}_in`, '', node, 'audio', demand(row.a_src))
				}
			}
		}),
	])

	await watchAll(pending)
	self.log('info', `Processors: ${state.inputs.size} routable input(s), ${state.outputs.size} output(s)`)
	batcher.flush()
}
