import * as VAPI from 'vapi'
import * as VScript from 'vscript'
import { genlockOutputPath, NO_TIME_SOURCE } from './clocks.js'
import { canSetDirection, type BncDirection } from './io.js'
import type { ModuleInstance } from './main.js'
import {
	buildRegistry,
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

/**
 * Action definitions depend on which BNCs exist and which of them are reversible, so this is
 * rebuilt after every discovery rather than once at init.
 */
export function UpdateActions(self: ModuleInstance): void {
	const bncChoices = self.io.state.reversibleBncChoices()
	const firstBnc = bncChoices[0]?.id ?? 0

	const registry = buildRegistry(self.flowState)
	const sources = sourceChoices(registry)
	const destinations = destinationChoices(registry)
	const outputChoices = self.io.state.outputChoices()

	self.setActionDefinitions({
		/**
		 * Self-contained crosspoint change, as the router spec requires: one call routes one source
		 * to one destination, with no select-then-take workflow and no dependence on prior state.
		 */
		route: {
			name: 'Flows - Route Source To Destination',
			description:
				'Route an SDI source to an SDI destination, or clear it. Video and audio are separate levels and can be routed together or independently.',
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
			],
			callback: async (event) => {
				const vm = self.connection.vm
				if (!vm?.i_o_module) {
					self.log('warn', 'Cannot route: not connected, or this Blade has no IO module')
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
				const writer = resolveDestinationWriter(vm, live, destinationKey)
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
						await writer[level]!(essence)
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
