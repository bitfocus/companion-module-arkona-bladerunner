import {
	combineRgb,
	type CompanionButtonPresetDefinition,
	type CompanionPresetDefinitions,
	type CompanionTextPresetDefinition,
	type CompanionTextSize,
} from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import { TEMPERATURES } from './variables.js'

const WHITE = combineRgb(255, 255, 255)
const DARK = combineRgb(20, 20, 20)
const BLUE = combineRgb(0, 90, 200)
const SYSTEM_CATEGORY = 'System'
const GREEN = combineRgb(0, 140, 0)
const RED = combineRgb(200, 0, 0)
const MIXER_CATEGORY = 'Video Mixers'

/**
 * A read-only status button: a fixed caption above a live variable.
 *
 * System status has no feedbacks, so these are deliberately plain - the value carries the meaning,
 * and colouring one would imply a threshold the module does not actually evaluate.
 */
function statusPreset(
	name: string,
	caption: string,
	variable: string,
	size: CompanionTextSize = '14',
): CompanionButtonPresetDefinition {
	return {
		type: 'button',
		category: SYSTEM_CATEGORY,
		name,
		style: {
			text: `${caption}\\n$(Blade:${variable})`,
			size,
			color: WHITE,
			bgcolor: DARK,
			show_topbar: false,
		},
		steps: [],
		feedbacks: [],
	}
}

/**
 * A section heading inside a preset category.
 *
 * A text preset renders as a heading in the preset list rather than as a droppable button, which is
 * what makes one category read as several sections. Companion lists presets in definition order, so
 * each header is emitted immediately before the buttons it describes.
 */
function headerPreset(category: string, label: string, description: string): CompanionTextPresetDefinition {
	return {
		type: 'text',
		category,
		name: label,
		// Companion renders name and text together, so repeating the label here would just show twice.
		text: description,
	}
}

/**
 * One status button per discovered SDI port, so the ports are usable on a surface without hand
 * wiring feedbacks. Rebuilt on every discovery, since which BNCs are inputs can change.
 */
export function UpdatePresets(self: ModuleInstance): void {
	const presets: CompanionPresetDefinitions = {}
	const mixerButton = (
		name: string,
		text: string,
		actionId: string,
		actionOptions: Record<string, any>,
		feedbackId?: string,
		feedbackOptions: Record<string, any> = {},
		feedbackColor = GREEN,
	): CompanionButtonPresetDefinition => ({
		type: 'button',
		category: MIXER_CATEGORY,
		name,
		style: { text, size: '14', color: WHITE, bgcolor: DARK, show_topbar: false },
		steps: [{ down: [{ actionId, options: actionOptions }], up: [] }],
		feedbacks: feedbackId
			? [{ feedbackId, options: feedbackOptions, style: { bgcolor: feedbackColor, color: WHITE } }]
			: [],
	})

	presets.sys_header_control = headerPreset(SYSTEM_CATEGORY, 'Control', 'Identify this blade, and reboot it')
	presets.sys_identify = {
		type: 'button',
		category: SYSTEM_CATEGORY,
		name: 'Identify (toggle front panel blink)',
		style: {
			text: 'IDENTIFY',
			size: '14',
			color: WHITE,
			bgcolor: DARK,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'identify', options: { mode: 'toggle' } }], up: [] }],
		feedbacks: [{ feedbackId: 'identify', options: {}, style: { bgcolor: BLUE, color: WHITE } }],
	}

	// Deliberately styled as a warning: this interrupts every signal the blade carries.
	presets.sys_reboot = {
		type: 'button',
		category: SYSTEM_CATEGORY,
		name: 'Reboot Blade',
		style: {
			text: 'REBOOT',
			size: '14',
			color: WHITE,
			bgcolor: RED,
			show_topbar: false,
		},
		steps: [{ down: [{ actionId: 'reboot', options: { target: 'reboot' } }], up: [] }],
		feedbacks: [],
	}

	// All system status lives in one category, split by header buttons rather than by category, so
	// it reads as a single page of stats. Definition order is what the header separation relies on.
	presets.sys_header_identity = headerPreset(SYSTEM_CATEGORY, 'Identity', 'Device, software and slot information')
	const identity: Array<[string, string, string]> = [
		['device_type', 'Device Type', 'Type'],
		['device_serial', 'Device Serial', 'Serial'],
		['device_unique_id', 'Device Unique ID', 'UID'],
		['board_location', 'Board Location', 'Slot'],
		['short_desc', 'Description', 'Desc'],
		['sw_version', 'Software Version', 'SW'],
		['sw_build_date', 'Software Build Date', 'Built'],
		['booted_partition', 'Booted Partition', 'Boot'],
		['selected_fpga', 'FPGA Personality', 'FPGA'],
	]
	// Identity values vary a lot in length, so these size themselves.
	for (const [variable, name, caption] of identity) {
		presets[`sys_${variable}`] = statusPreset(name, caption, variable, 12)
	}

	presets.sys_header_health = headerPreset(SYSTEM_CATEGORY, 'Health', 'Uptime, CPU load, memory and processes')
	const health: Array<[string, string, string]> = [
		['uptime', 'Uptime', 'Uptime'],
		['uptime_seconds', 'Uptime (seconds)', 'Uptime (s)'],
		['load_avg_1', 'Load Average, 1 Minute', 'Load (1m)'],
		['load_avg_5', 'Load Average, 5 Minutes', 'Load (5m)'],
		['load_avg_15', 'Load Average, 15 Minutes', 'Load (15m)'],
		['free_ram_mb', 'Free Memory', 'Free (MB)'],
		['procs', 'Running Processes', 'Procs'],
		['num_cores', 'Active CPU Cores', 'Cores'],
	]
	for (const [variable, name, caption] of health) {
		presets[`sys_${variable}`] = statusPreset(name, caption, variable, 12)
	}

	presets.sys_header_temperatures = headerPreset(SYSTEM_CATEGORY, 'Temperatures', 'On-board temperature sensors, in °C')
	for (const [variable, , name, caption] of TEMPERATURES) {
		presets[`sys_${variable}`] = statusPreset(name, caption, variable, 12)
	}

	// Fan and PSU counts are discovered, so these groups only appear for rows the chassis has.
	if (self.tableCounts.fans.length > 0)
		presets.sys_header_fans = headerPreset(SYSTEM_CATEGORY, 'Fans', 'Chassis fan speeds, in RPM')
	for (const i of self.tableCounts.fans) {
		presets[`sys_fan_${i}`] = {
			type: 'button',
			category: SYSTEM_CATEGORY,
			name: `Fan ${i} Speed`,
			style: {
				text: `$(Blade:fan_${i}_id)\\n$(Blade:fan_${i}_speed)`,
				size: 12,
				color: WHITE,
				bgcolor: DARK,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [],
		}
	}

	if (self.tableCounts.psus.length > 0)
		presets.sys_header_power = headerPreset(
			SYSTEM_CATEGORY,
			'Power',
			'PSU input voltage, current and hotspot temperature',
		)
	for (const i of self.tableCounts.psus) {
		presets[`sys_psu_${i}`] = {
			type: 'button',
			category: SYSTEM_CATEGORY,
			name: `PSU ${i} Summary`,
			style: {
				text: `PSU ${i}\\n$(Blade:psu_${i}_vin)V $(Blade:psu_${i}_iin)A\\n$(Blade:psu_${i}_temp)`,
				size: 12,
				color: WHITE,
				bgcolor: DARK,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [],
		}
		presets[`sys_psu_${i}_on`] = statusPreset(`PSU ${i} On`, `PSU ${i}`, `psu_${i}_on`)
		presets[`sys_psu_${i}_vin`] = statusPreset(`PSU ${i} Input Voltage`, `PSU ${i} V`, `psu_${i}_vin`)
		presets[`sys_psu_${i}_iin`] = statusPreset(`PSU ${i} Input Current`, `PSU ${i} A`, `psu_${i}_iin`)
		presets[`sys_psu_${i}_temp`] = statusPreset(`PSU ${i} Hotspot Temperature`, `PSU ${i} deg C`, `psu_${i}_temp`)
	}

	presets.sys_header_clocks = headerPreset(
		SYSTEM_CATEGORY,
		'Clocks',
		'PTP lock, offset and drift, and the genlock instances',
	)
	const ptp: Array<[string, string, string]> = [
		['ptp_state', 'PTP Clock State', 'PTP'],
		['ptp_mode', 'PTP Clock Mode', 'PTP Mode'],
		['ptp_offset_ns', 'PTP Offset To Master', 'Offset ns'],
		['ptp_drift_ppm', 'PTP Master Drift', 'Drift ppm'],
		['ptp_clock_speed_ppm', 'PTP Local Clock Speed', 'Clock ppm'],
	]
	for (const [variable, name, caption] of ptp) {
		presets[`sys_${variable}`] = statusPreset(name, caption, variable, 12)
	}

	// The one PTP button worth colouring: locked or not is the question operators actually ask.
	presets.sys_ptp_locked = {
		type: 'button',
		category: SYSTEM_CATEGORY,
		name: 'PTP Locked',
		style: {
			text: 'PTP\\n$(Blade:ptp_state)',
			size: '14',
			color: WHITE,
			bgcolor: DARK,
			show_topbar: false,
		},
		steps: [],
		feedbacks: [{ feedbackId: 'ptp_locked', options: {}, style: { bgcolor: GREEN, color: WHITE } }],
	}

	for (const genlock of self.clocks.genlocks.values()) {
		presets[`sys_genlock_${genlock.index}`] = {
			type: 'button',
			category: SYSTEM_CATEGORY,
			name: `${genlock.name} Status`,
			style: {
				text: `GL ${genlock.index}\\n$(Blade:genlock_${genlock.index}_offset_ns)`,
				size: '14',
				color: WHITE,
				bgcolor: DARK,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{
					feedbackId: 'genlock_in_use',
					options: { genlock: genlock.index },
					style: { bgcolor: GREEN, color: WHITE },
				},
			],
		}
	}

	for (const mixer of self.processors.videoMixers.values()) {
		const i = mixer.index
		const name = self.processors.nodeNames.get(`mixer_${i}`) ?? `Mixer ${i}`
		const key = `mixer_${i}`
		presets[`${key}_header`] = headerPreset(MIXER_CATEGORY, name, 'Mode and A/B transition controls')

		const modes: Array<[string, string, string]> = [
			['MIXER', 'A/B MIX', 'A/B Mixer'],
			['MIXER_INDEPENDENT', 'INDEP', 'Independent Mixer'],
			['LUMA_KEYER', 'LUMA', 'Luma Keyer'],
			['LUMA_KEYER_ADDITIVE', 'LUMA +', 'Additive Luma Keyer'],
		]
		for (const [mode, text, label] of modes) {
			presets[`${key}_mode_${mode.toLowerCase()}`] = mixerButton(
				`${name} - ${label} Mode`,
				text,
				'video_mixer_mode',
				{ mixer: i, mode },
				'video_mixer_mode',
				{ mixer: i, mode },
				BLUE,
			)
		}

		for (const [input, label] of [
			['a', 'A'],
			['b', 'B'],
		] as const) {
			presets[`${key}_cut_${input}`] = mixerButton(
				`${name} - Cut ${label}`,
				`CUT\n${label}`,
				'video_mixer_fader',
				{ mixer: i, input, style: 'cut', duration: 1000 },
				'video_mixer_input',
				{ mixer: i, input },
			)
			presets[`${key}_fade_${input}`] = mixerButton(
				`${name} - Fade ${label} (1 second)`,
				`FADE\n${label}`,
				'video_mixer_fader',
				{ mixer: i, input, style: 'fade', duration: 1000 },
				'video_mixer_input',
				{ mixer: i, input },
			)
		}
		presets[`${key}_toggle_cut`] = mixerButton(`${name} - Toggle Cut`, 'TAKE', 'video_mixer_fader', {
			mixer: i,
			input: 'toggle',
			style: 'cut',
			duration: 1000,
		})
		presets[`${key}_toggle_fade`] = mixerButton(`${name} - Toggle Fade (1 second)`, 'AUTO', 'video_mixer_fader', {
			mixer: i,
			input: 'toggle',
			style: 'fade',
			duration: 1000,
		})
	}

	presets.sdi_header_status_inputs = headerPreset('SDI Inputs', 'Status', 'Current status of available SDI inputs')
	for (const input of self.io.state.inputs.values()) {
		presets[`sdi_in_${input.index}`] = {
			type: 'button',
			category: 'SDI Inputs',
			name: `SDI input ${input.index} status`,
			style: {
				text: `IN ${input.index}\\n$(Blade:sdi_in_${input.index}_standard)`,
				size: 12,
				color: WHITE,
				bgcolor: DARK,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{ feedbackId: 'sdi_input_locked', options: { input: input.index }, style: { bgcolor: GREEN, color: WHITE } },
			],
		}
	}
	presets.sdi_header_status_outputs = headerPreset('SDI Outputs', 'Status', 'Current status of available SDI outputs')
	for (const output of self.io.state.outputs.values()) {
		presets[`sdi_out_${output.index}`] = {
			type: 'button',
			category: 'SDI Outputs',
			name: `SDI output ${output.index} status`,
			style: {
				text: `OUT ${output.index}\\n$(Blade:sdi_out_${output.index}_source)`,
				size: 12,
				color: WHITE,
				bgcolor: DARK,
				show_topbar: false,
			},
			steps: [],
			feedbacks: [
				{ feedbackId: 'sdi_output_active', options: { output: output.index }, style: { bgcolor: GREEN, color: WHITE } },
				{
					feedbackId: 'sdi_output_issues',
					options: { output: output.index, issue: 'any' },
					style: { bgcolor: RED, color: WHITE },
				},
			],
		}
	}

	self.setPresetDefinitions(presets)
}
