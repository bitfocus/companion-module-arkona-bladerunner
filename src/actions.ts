import type { CompanionActionEvent, CompanionInputFieldDropdown } from '@companion-module/base'
import * as VAPI from 'vapi'
import * as VScript from 'vscript'
import { genlockOutputPath, NO_TIME_SOURCE } from './clocks.js'
import { canSetDirection, type BncDirection } from './io.js'
import type { ModuleInstance } from './main.js'
import type { VideoMixerState } from './processors.js'
import {
	buildRegistry,
	type FlowRegistry,
	sourceChannelOption,
	destinationChoices,
	levelsForOption,
	NO_SOURCE,
	isSelfLoop,
	resolveDestinationWriter,
	resolveSourceEssence,
	ROUTE_LEVEL_CHOICES,
	sourceChoices,
	type FlowLevel,
} from './routing.js'
import { describeWriteError, writeBlockedReason } from './vm.js'

/** Resolve the switcher-style A/B choice to fader 0's device value. */
export function mixerTransitionTarget(input: string, current: number): number {
	if (input === 'a') return 0
	if (input === 'b') return 1
	// Mid-transition, toggle heads away from the nearest end.
	return current < 0.5 ? 1 : 0
}

/** The Set/Adjust toggle shared by every action that can write an absolute value or nudge one. */
function operationOption(): CompanionInputFieldDropdown {
	return {
		id: 'operation',
		type: 'dropdown',
		label: 'Operation',
		default: 'set',
		choices: [
			{ id: 'set', label: 'Set' },
			{ id: 'adjust', label: 'Adjust' },
		],
	}
}

/** Apply an absolute value or signed adjustment, keeping the device write inside its range. */
export function adjustedTarget(
	operation: string,
	value: number,
	current: number | null,
	minimum: number,
	maximum: number,
): number | null {
	if (operation === 'adjust' && current === null) return null
	const target = operation === 'adjust' ? current! + value : value
	return Math.min(maximum, Math.max(minimum, target))
}

/**
 * Shared body for the mixer actions that set or adjust one ranged luma/key parameter: validate the
 * mixer is available and unblocked, compute the target from the Set/Adjust options, and write it.
 */
async function writeMixerRangeValue(
	self: ModuleInstance,
	event: CompanionActionEvent,
	label: string,
	min: number,
	max: number,
	scale: number,
	current: (live: VideoMixerState) => number | null,
	write: (mixer: NonNullable<VAPI.AT1130.Root['video_mixer']>, index: number, target: number) => Promise<void>,
): Promise<void> {
	const vm = self.connection.vm
	const index = Number(event.options.mixer)
	const live = self.processors.videoMixers.get(index)
	if (!vm?.video_mixer || !live) {
		self.log('warn', `Cannot set ${label}: mixer ${index} is not available`)
		return
	}
	const blocked = writeBlockedReason(self.config.towel, vm)
	if (blocked) return self.log('warn', `Cannot set ${label}: ${blocked}`)
	const operation = String(event.options.operation)
	const amount = Number(operation === 'adjust' ? event.options.adjustment : event.options.value) / scale
	const target = adjustedTarget(operation, amount, current(live), min, max)
	if (target === null) {
		self.log('warn', `Cannot adjust mixer ${index} ${label}: its current value is not known`)
		return
	}
	try {
		await write(vm.video_mixer, index, target)
	} catch (e: any) {
		self.log('error', `Failed to set mixer ${index} ${label}: ${describeWriteError(e)}`)
	}
}

/**
 * Action definitions depend on which BNCs exist and which of them are reversible, so this is
 * rebuilt after every discovery rather than once at init.
 */
export function UpdateActions(self: ModuleInstance, registry: FlowRegistry): void {
	const bncChoices = self.io.state.reversibleBncChoices()
	const firstBnc = bncChoices[0]?.id ?? 0

	const sources = sourceChoices(registry)
	const destinations = destinationChoices(registry)
	const outputChoices = self.io.state.outputChoices()
	const receiverChoices = [
		...[...self.rtp.videoReceivers.values()].map((r) => ({ id: `v_${r.index}`, label: r.name })),
		...[...self.rtp.audioReceivers.values()].map((r) => ({ id: `a_${r.index}`, label: r.name })),
	]
	const mixerChoices = self.processors.videoMixerChoices()
	const firstMixer = mixerChoices[0]?.id ?? 0

	self.setActionDefinitions({
		video_mixer_mode: {
			name: 'Video Mixer - Set Mode',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'MIXER',
					choices: [
						{ id: 'MIXER', label: 'Mixer' },
						{ id: 'MIXER_INDEPENDENT', label: 'Mixer - Independent' },
						{ id: 'LUMA_KEYER', label: 'Luma Keyer' },
						{ id: 'LUMA_KEYER_ADDITIVE', label: 'Luma Keyer - Additive' },
					],
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				const index = Number(event.options.mixer)
				if (!vm?.video_mixer || !self.processors.videoMixers.has(index)) {
					self.log('warn', `Cannot set mixer mode: mixer ${index} is not available`)
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) return self.log('warn', `Cannot set mixer mode: ${blocked}`)
				try {
					await vm.video_mixer.instances.row(index).mode.write(String(event.options.mode) as VAPI.VideoMixer.BSLKMode)
				} catch (e: any) {
					self.log('error', `Failed to set mixer ${index} mode: ${describeWriteError(e)}`)
				}
			},
		},

		video_mixer_fader: {
			name: 'Video Mixer - Transition',
			description: 'Cut or fade to A or B, or toggle to the other input. Applies to fader 0 in Mixer mode.',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'input',
					type: 'dropdown',
					label: 'Input',
					default: 'toggle',
					choices: [
						{ id: 'toggle', label: 'Toggle A / B' },
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' },
					],
				},
				{
					id: 'style',
					type: 'dropdown',
					label: 'Transition',
					default: 'cut',
					choices: [
						{ id: 'cut', label: 'Cut' },
						{ id: 'fade', label: 'Fade' },
					],
				},
				{
					id: 'duration',
					type: 'number',
					label: 'Fade Duration (ms)',
					default: 1000,
					min: 1,
					max: 600000,
					step: 1,
					isVisibleExpression: `$(options:style) == 'fade'`,
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				const index = Number(event.options.mixer)
				const live = self.processors.videoMixers.get(index)
				if (!vm?.video_mixer || !live) {
					self.log('warn', `Cannot transition mixer: mixer ${index} is not available`)
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) return self.log('warn', `Cannot transition mixer: ${blocked}`)
				const requested = String(event.options.input)
				if (requested === 'toggle' && live.fader0 === null) {
					self.log('warn', `Cannot toggle mixer ${index}: its current fader position is not known`)
					return
				}
				const target = mixerTransitionTarget(requested, live.fader0 ?? 0)
				const duration = event.options.style === 'fade' ? Number(event.options.duration) : 0
				try {
					await vm.video_mixer.instances.row(index).mixer.fader0.transition.write({
						target,
						time: new VScript.Duration(duration, 'ms'),
					})
				} catch (e: any) {
					self.log('error', `Failed to transition mixer ${index}: ${describeWriteError(e)}`)
				}
			},
		},

		video_mixer_fader_level: {
			name: 'Video Mixer - Fader Level (Advanced)',
			description: 'Set or adjust either fader, including fader 1 in Independent Mixer mode.',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'fader',
					type: 'dropdown',
					label: 'Fader',
					default: 0,
					choices: [
						{ id: 0, label: 'Fader 0' },
						{ id: 1, label: 'Fader 1' },
					],
				},
				operationOption(),
				{
					id: 'value',
					type: 'number',
					label: 'Level (%)',
					default: 100,
					min: 0,
					max: 100,
					step: 0.1,
					isVisibleExpression: `$(options:operation) == 'set'`,
				},
				{
					id: 'adjustment',
					type: 'number',
					label: 'Adjustment (% points)',
					default: 5,
					min: -100,
					max: 100,
					step: 0.1,
					isVisibleExpression: `$(options:operation) == 'adjust'`,
				},
				{
					id: 'duration',
					type: 'number',
					label: 'Full Transition Duration (ms)',
					tooltip: 'Use 0 for an immediate move.',
					default: 0,
					min: 0,
					max: 600000,
					step: 1,
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				const index = Number(event.options.mixer)
				const live = self.processors.videoMixers.get(index)
				if (!vm?.video_mixer || !live) {
					self.log('warn', `Cannot set mixer fader: mixer ${index} is not available`)
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) return self.log('warn', `Cannot set mixer fader: ${blocked}`)
				const fader = Number(event.options.fader)
				const operation = String(event.options.operation)
				const amount = Number(operation === 'adjust' ? event.options.adjustment : event.options.value) / 100
				const target = adjustedTarget(operation, amount, fader === 1 ? live.fader1 : live.fader0, 0, 1)
				if (target === null) {
					self.log('warn', `Cannot adjust mixer ${index} fader ${fader}: its current level is not known`)
					return
				}
				try {
					const row = vm.video_mixer.instances.row(index)
					await (fader === 1 ? row.mixer.fader1 : row.mixer.fader0).transition.write({
						target,
						time: new VScript.Duration(Number(event.options.duration), 'ms'),
					})
				} catch (e: any) {
					self.log('error', `Failed to set mixer ${index} fader ${fader}: ${describeWriteError(e)}`)
				}
			},
		},

		video_mixer_luma_clip: {
			name: 'Video Mixer - Luma Key Clip',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				operationOption(),
				{
					id: 'value',
					type: 'number',
					label: 'Clip',
					default: 0,
					min: -0.07,
					max: 1.07,
					step: 0.001,
					isVisibleExpression: `$(options:operation) == 'set'`,
				},
				{
					id: 'adjustment',
					type: 'number',
					label: 'Adjustment',
					default: 0.01,
					min: -1.14,
					max: 1.14,
					step: 0.001,
					isVisibleExpression: `$(options:operation) == 'adjust'`,
				},
			],
			callback: async (event) =>
				writeMixerRangeValue(
					self,
					event,
					'luma key clip',
					-0.07,
					1.07,
					1,
					(live) => live.clip,
					async (mixer, index, target) => mixer.instances.row(index).luma_keyer.clip.write(target),
				),
		},

		video_mixer_luma_gain: {
			name: 'Video Mixer - Luma Key Gain',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				operationOption(),
				{
					id: 'value',
					type: 'number',
					label: 'Gain',
					default: 1,
					min: 0.001,
					max: 1.131,
					step: 0.001,
					isVisibleExpression: `$(options:operation) == 'set'`,
				},
				{
					id: 'adjustment',
					type: 'number',
					label: 'Adjustment',
					default: 0.01,
					min: -1.13,
					max: 1.13,
					step: 0.001,
					isVisibleExpression: `$(options:operation) == 'adjust'`,
				},
			],
			callback: async (event) =>
				writeMixerRangeValue(
					self,
					event,
					'luma key gain',
					0.001,
					1.131,
					1,
					(live) => live.gain,
					async (mixer, index, target) => mixer.instances.row(index).luma_keyer.gain.write(target),
				),
		},

		video_mixer_key_opacity: {
			name: 'Video Mixer - Key Opacity',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				operationOption(),
				{
					id: 'value',
					type: 'number',
					label: 'Opacity (%)',
					default: 100,
					min: 0,
					max: 100,
					step: 0.1,
					isVisibleExpression: `$(options:operation) == 'set'`,
				},
				{
					id: 'adjustment',
					type: 'number',
					label: 'Adjustment (% points)',
					default: 5,
					min: -100,
					max: 100,
					step: 0.1,
					isVisibleExpression: `$(options:operation) == 'adjust'`,
				},
				{
					id: 'duration',
					type: 'number',
					label: 'Full Transition Duration (ms)',
					default: 0,
					min: 0,
					max: 600000,
					step: 1,
				},
			],
			callback: async (event) =>
				writeMixerRangeValue(
					self,
					event,
					'key opacity',
					0,
					1,
					100,
					(live) => live.opacity,
					async (mixer, index, target) =>
						mixer.instances.row(index).luma_keyer.opacity.transition.write({
							target,
							time: new VScript.Duration(Number(event.options.duration), 'ms'),
						}),
				),
		},

		video_mixer_key_invert: {
			name: 'Video Mixer - Set Key Invert',
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'invert',
					type: 'dropdown',
					label: 'Invert',
					default: 'toggle',
					choices: [
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				const index = Number(event.options.mixer)
				const live = self.processors.videoMixers.get(index)
				if (!vm?.video_mixer || !live) {
					self.log('warn', `Cannot invert key: mixer ${index} is not available`)
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) return self.log('warn', `Cannot invert key: ${blocked}`)
				const requested = String(event.options.invert)
				if (requested === 'toggle' && live.invert === null) {
					self.log('warn', `Cannot toggle mixer ${index} key invert: its current state is not known`)
					return
				}
				const target = requested === 'toggle' ? !live.invert : requested === 'on'
				try {
					await vm.video_mixer.instances.row(index).luma_keyer.invert.write(target)
				} catch (e: any) {
					self.log('error', `Failed to set mixer ${index} key invert: ${describeWriteError(e)}`)
				}
			},
		},

		/**
		 * Self-contained crosspoint change, as the router spec requires: one call routes one source
		 * to one destination, with no select-then-take workflow and no dependence on prior state.
		 */
		route: {
			name: 'Flows - Route Source To Destination',
			description:
				'Route a source to a destination, or clear it. Video and audio are separate levels and can be routed together or independently.',
			options: [
				{ id: 'source', type: 'dropdown', label: 'Source', default: NO_SOURCE, choices: sources },
				{
					id: 'destination',
					type: 'dropdown',
					label: 'Destination',
					default: destinations[0]?.id ?? '',
					choices: destinations,
				},
				{ id: 'level', type: 'dropdown', label: 'Level', default: 'both', choices: ROUTE_LEVEL_CHOICES },
				sourceChannelOption(registry),
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm) {
					self.log('warn', 'Cannot route: not connected to the Blade')
					return
				}

				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot route: ${blocked}`)
					return
				}

				// Rebuilt per call so a BNC that changed direction since the definitions were registered
				// is validated against reality, not against a stale port list.
				const live = buildRegistry(self.flowState)

				const destinationKey = String(event.options.destination)
				const writer = resolveDestinationWriter(vm, live, destinationKey, self.processors)
				if (!writer) {
					self.log('warn', `Cannot route: destination '${destinationKey}' does not exist on this Blade`)
					return
				}

				const sourceKey = String(event.options.source)
				const clearing = sourceKey === NO_SOURCE
				if (!clearing && !live.sources.has(sourceKey)) {
					self.log('warn', `Cannot route: source '${sourceKey}' does not exist on this Blade`)
					return
				}

				// Sources of every kind are resolved the same way: revive the essence named by the
				// registry's path. That is what lets generators join without special cases.
				// Nested functions do not keep the connection-guard narrowing, so capture the live root.
				const root = vm
				function revive(path: string, essenceLevel: 'video'): VAPI.AT1130.Video.Essence
				function revive(path: string, essenceLevel: 'audio'): VAPI.AT1130.Audio.Essence
				function revive(path: string, essenceLevel: FlowLevel): VAPI.AT1130.Video.Essence | VAPI.AT1130.Audio.Essence {
					const subtree = VScript.VAPIHelpers.get_subtree(root.raw, path)
					if (essenceLevel === 'video') return VAPI.AT1130.Video.lift.Essence(subtree)
					return VAPI.AT1130.Audio.lift.Essence(subtree)
				}

				if (!clearing && isSelfLoop(live, sourceKey, destinationKey)) {
					self.log('warn', `Cannot route: ${sourceKey} is the output of the same processor as ${destinationKey}`)
					return
				}

				const source = live.sources.get(sourceKey)
				const destination = live.destinations.get(destinationKey)
				const requested = levelsForOption(String(event.options.level))

				// A level needs both ends to carry it, and the two shortfalls are different problems:
				// an ST 2110 video transmitter cannot take audio at all, whereas a video generator
				// simply has none to give. Saying which end is the constraint is the difference between
				// a useful log line and a confusing one.
				const missingAtDestination = requested.filter(
					(l) => !destination?.levels.includes(l) || writer[l] === undefined,
				)
				const missingAtSource = clearing
					? []
					: requested.filter((l) => !missingAtDestination.includes(l) && !source?.levels.includes(l))
				const levels = requested.filter((l) => !missingAtDestination.includes(l) && !missingAtSource.includes(l))

				if (missingAtDestination.length > 0) {
					self.log('info', `${destinationKey} has no ${missingAtDestination.join('/')}; leaving that level unchanged`)
				}
				if (missingAtSource.length > 0) {
					self.log('info', `${sourceKey} has no ${missingAtSource.join('/')}; leaving that level unchanged`)
				}
				if (levels.length === 0) {
					const why =
						missingAtDestination.length > 0 && missingAtSource.length === 0
							? `${destinationKey} carries none of the selected levels`
							: `${sourceKey} provides none of the selected levels`
					self.log('warn', `Cannot route: ${why}`)
					return
				}
				// Only a channel-selecting destination reads this; everything else takes the whole essence.
				const sourceChannel = Number(event.options.source_channel ?? 0)
				const succeeded: FlowLevel[] = []
				const failed: string[] = []

				// The levels are applied independently and both are attempted: there is no transaction
				// here, so a partial result is reported rather than hidden.
				for (const level of levels) {
					try {
						const essence = clearing ? null : resolveSourceEssence(live, sourceKey, level, revive)
						// The writer knows how each destination kind applies a level: an SDI output's video
						// goes through set_video_source, which waits for the output to actually carry the
						// source, while everything else is a plain TimedSource write.
						await writer[level]!(essence, sourceChannel)
						succeeded.push(level)
					} catch (e: any) {
						failed.push(`${level}: ${describeWriteError(e)}`)
					}
				}

				const what = clearing ? `Cleared ${destinationKey}` : `Routed ${sourceKey} to ${destinationKey}`
				if (failed.length === 0) {
					self.log('info', `${what} (${succeeded.join(' + ')})`)
				} else if (succeeded.length === 0) {
					self.log('error', `Failed to route ${sourceKey} to ${destinationKey} - ${failed.join('; ')}`)
				} else {
					self.log('error', `Partly applied: ${what} on ${succeeded.join(' + ')}, but failed on ${failed.join('; ')}`)
				}
			},
		},

		identify: {
			name: 'System - Identify (Front Panel Blink)',
			description: 'Blink the front panel LED blue to locate this blade in a rack.',
			options: [
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Action',
					default: 'toggle',
					choices: [
						{ id: 'on', label: 'Start blinking' },
						{ id: 'off', label: 'Stop blinking' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm) {
					self.log('warn', 'Cannot identify: not connected')
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot identify: ${blocked}`)
					return
				}
				const mode = String(event.options.mode)
				const target = mode === 'toggle' ? !self.identifyActive : mode === 'on'
				try {
					await vm.system.frontpanel_blink_blue.write(target)
				} catch (e: any) {
					self.log('error', `Failed to set identify: ${describeWriteError(e)}`)
				}
			},
		},

		set_time_source: {
			name: 'SDI - Set Output Time Source',
			description:
				'Point an SDI output at a genlock instance or the PTP clock. An output with no time source cannot carry a routed video source.',
			options: [
				{
					id: 'destination',
					type: 'dropdown',
					label: 'SDI output',
					default: outputChoices[0]?.id ?? 0,
					choices: outputChoices,
				},
				{
					id: 'time_source',
					type: 'dropdown',
					label: 'Time source',
					default: genlockOutputPath(0),
					choices: self.clocks.timeSourceChoices(),
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm?.i_o_module) {
					self.log('warn', 'Cannot set time source: not connected, or this Blade has no IO module')
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot set time source: ${blocked}`)
					return
				}

				const index = Number(event.options.destination)
				if (!self.io.state.outputs.has(index)) {
					self.log('warn', `Cannot set time source: SDI output ${index} does not exist on this Blade`)
					return
				}

				const path = String(event.options.time_source)
				// The choice ID is the keyword path, so the source is revived from it directly.
				const source =
					path === NO_TIME_SOURCE ? null : VAPI.AT1130.Time.lift.Source(VScript.VAPIHelpers.get_subtree(vm.raw, path))
				try {
					await vm.i_o_module.output.row(index).sdi.t_src.command.write(source)
					self.log(
						'info',
						source ? `SDI output ${index} time source set to ${path}` : `Cleared SDI output ${index} time source`,
					)
				} catch (e: any) {
					self.log('error', `Failed to set time source on SDI output ${index}: ${describeWriteError(e)}`)
				}
			},
		},

		/**
		 * Counters accumulate until they are cleared, so clearing is how an operator establishes a
		 * baseline before a test - "nothing since I pressed this" is the useful reading.
		 */
		clear_rtp_counters: {
			name: 'RTP - Clear Receiver Counters',
			description: "Reset a receiver's error and event counters",
			options: [
				{
					id: 'receiver',
					type: 'dropdown',
					label: 'Receiver',
					default: receiverChoices[0]?.id ?? '',
					choices: receiverChoices,
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				const rx = vm?.r_t_p_receiver
				if (!rx) {
					self.log('warn', 'Cannot clear counters: not connected, or this Blade has no RTP receiver')
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot clear counters: ${blocked}`)
					return
				}
				const match = /^(v|a)_(\d+)$/.exec(String(event.options.receiver))
				if (!match) {
					self.log('warn', `Cannot clear counters: receiver '${event.options.receiver}' is invalid`)
					return
				}
				const table = match[1] === 'v' ? rx.video_receivers : rx.audio_receivers
				const generic = table.row(Number(match[2])).generic
				try {
					await generic.clear_error_counters.write('Click')
					await generic.clear_event_counters.write('Click')
				} catch (e: any) {
					self.log('error', `Failed to clear receiver counters: ${describeWriteError(e)}`)
				}
			},
		},

		reboot: {
			name: 'System - Reboot Blade',
			description:
				'Reboot the blade. This interrupts every signal it is carrying. "Reboot" restarts the running partition; Select System 0 or System 1 to boot to that partition instead.',
			options: [
				{
					id: 'target',
					type: 'dropdown',
					label: 'Target',
					default: 'reboot',
					choices: [
						{ id: 'reboot', label: 'Reboot current partition' },
						{ id: 'system0', label: 'Reboot into System 0' },
						{ id: 'system1', label: 'Reboot into System 1' },
					],
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm) {
					self.log('warn', 'Cannot reboot: not connected')
					return
				}
				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot reboot: ${blocked}`)
					return
				}
				const target = String(event.options.target)
				try {
					// The socket drops as the blade goes down; vscript reconnects on its own and the
					// connection reports "expected-close" rather than a failure.
					self.log('warn', `Rebooting the blade (${target}) - all signals will be interrupted`)
					await vm.system.reboot.write(target)
				} catch (e: any) {
					self.log('error', `Failed to reboot: ${describeWriteError(e)}`)
				}
			},
		},

		set_sdi_configuration: {
			name: 'SDI - Set I/O Configuration',
			description:
				'Reconfigure a BNC as an input or an output. This tears down any signal on that port and reallocates the SDI port tables.',
			options: [
				{ id: 'bnc', type: 'dropdown', label: 'BNC', default: firstBnc, choices: bncChoices },
				{
					id: 'direction',
					type: 'dropdown',
					label: 'Direction',
					default: 'toggle',
					choices: [
						{ id: 'Input', label: 'Input' },
						{ id: 'Output', label: 'Output' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm?.i_o_module) {
					self.log('warn', 'Cannot set BNC direction: not connected, or this Blade has no IO module')
					return
				}

				const blocked = writeBlockedReason(self.config.towel, vm)
				if (blocked) {
					self.log('warn', `Cannot set BNC direction: ${blocked}`)
					return
				}

				const index = Number(event.options.bnc)
				const bnc = self.io.state.bncs.get(index)
				if (!bnc) {
					self.log('warn', `Cannot set BNC direction: BNC ${index} does not exist on this Blade`)
					return
				}

				const requested = String(event.options.direction)
				// Toggle needs the current direction; if we have not read it yet there is nothing to invert.
				const target: BncDirection | null =
					requested === 'toggle'
						? bnc.direction === 'Input'
							? 'Output'
							: bnc.direction === 'Output'
								? 'Input'
								: null
						: (requested as BncDirection)

				if (target === null) {
					self.log('warn', `Cannot toggle BNC ${index}: its current direction is not known yet`)
					return
				}

				if (!canSetDirection(bnc, target)) {
					self.log('warn', `BNC ${index} cannot be set to ${target} (hardware capability is ${bnc.capability})`)
					return
				}

				if (bnc.direction === target) {
					self.log('debug', `BNC ${index} is already ${target}`)
					return
				}

				try {
					// The direction watch picks the change up and triggers rediscovery of the port tables.
					await vm.i_o_module.configuration.row(index).direction.write(target)
					self.log('info', `Set BNC ${index} to ${target}`)
				} catch (e: any) {
					self.log('error', `Failed to set BNC ${index} to ${target}: ${describeWriteError(e)}`)
				}
			},
		},
	})
}
