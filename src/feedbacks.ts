import { combineRgb } from '@companion-module/base'
import * as VAPI from 'vapi'
import { isPtpLocked } from './clocks.js'
import { formatStandard, isLocked } from './io.js'
import { ANY_ISSUE_SOURCE, issueChoices, SDI_OUTPUT_ISSUE_LABELS } from './issues.js'
import type { ModuleInstance } from './main.js'
import {
	type FlowRegistry,
	sourceChannelOption,
	destinationChoices,
	isBreakaway,
	levelsForOption,
	NO_SOURCE,
	ROUTE_LEVEL_CHOICES,
	sourceChoices,
} from './routing.js'

const RED = combineRgb(200, 0, 0)
const AMBER = combineRgb(210, 130, 0)
const GREEN = combineRgb(0, 140, 0)
const BLACK = combineRgb(0, 0, 0)
const WHITE = combineRgb(255, 255, 255)
const BLUE = combineRgb(0, 90, 200)

/**
 * Feedback definitions depend on which BNCs are currently inputs and which are outputs, so this is
 * called again after every discovery rather than once at init.
 */
export function UpdateFeedbacks(self: ModuleInstance, registry: FlowRegistry): void {
	const inputChoices = self.io.state.inputChoices()
	const outputChoices = self.io.state.outputChoices()
	const bncChoices = self.io.state.bncChoices()
	const firstInput = inputChoices[0]?.id ?? 0
	const firstOutput = outputChoices[0]?.id ?? 0
	const firstBnc = bncChoices[0]?.id ?? 0

	const flowSources = sourceChoices(registry)
	const flowDestinations = destinationChoices(registry)
	const mixerChoices = self.processors.videoMixerChoices()
	const firstMixer = mixerChoices[0]?.id ?? 0
	const near = (actual: number | null, wanted: number): boolean => actual !== null && Math.abs(actual - wanted) <= 0.005

	self.setFeedbackDefinitions({
		video_mixer_mode: {
			name: 'Video Mixer - Mode Selected',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
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
			callback: (feedback) =>
				self.processors.videoMixers.get(Number(feedback.options.mixer))?.mode === feedback.options.mode,
		},

		video_mixer_fader: {
			name: 'Video Mixer - Fader At Value',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
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
				{ id: 'value', type: 'number', label: 'Value (%)', default: 100, min: 0, max: 100, step: 0.1 },
			],
			callback: (feedback) => {
				const mixer = self.processors.videoMixers.get(Number(feedback.options.mixer))
				const actual = Number(feedback.options.fader) === 1 ? mixer?.fader1 : mixer?.fader0
				return near(actual ?? null, Number(feedback.options.value) / 100)
			},
		},

		video_mixer_input: {
			name: 'Video Mixer - Input Selected',
			description: 'True at an end stop in Mixer mode. Fader 0 at 0% selects A; 100% selects B.',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'input',
					type: 'dropdown',
					label: 'Input',
					default: 'a',
					choices: [
						{ id: 'a', label: 'A' },
						{ id: 'b', label: 'B' },
					],
				},
			],
			callback: (feedback) => {
				const mixer = self.processors.videoMixers.get(Number(feedback.options.mixer))
				if (mixer?.mode !== 'MIXER') return false
				return near(mixer.fader0, feedback.options.input === 'a' ? 0 : 1)
			},
		},

		video_mixer_luma_value: {
			name: 'Video Mixer - Luma Key Clip / Gain At Value',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{
					id: 'parameter',
					type: 'dropdown',
					label: 'Parameter',
					default: 'clip',
					choices: [
						{ id: 'clip', label: 'Clip' },
						{ id: 'gain', label: 'Gain' },
					],
				},
				{
					id: 'value',
					type: 'number',
					label: 'Value',
					tooltip: 'Clip range: -0.07–1.07. Gain range: 0.001–1.131.',
					default: 0,
					min: -0.07,
					max: 1.131,
					step: 0.001,
				},
			],
			callback: (feedback) => {
				const mixer = self.processors.videoMixers.get(Number(feedback.options.mixer))
				const actual = feedback.options.parameter === 'gain' ? mixer?.gain : mixer?.clip
				return actual !== null && actual !== undefined && Math.abs(actual - Number(feedback.options.value)) <= 0.0005
			},
		},

		video_mixer_key_opacity: {
			name: 'Video Mixer - Key Opacity At Value',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices },
				{ id: 'value', type: 'number', label: 'Value (%)', default: 100, min: 0, max: 100, step: 0.1 },
			],
			callback: (feedback) =>
				near(
					self.processors.videoMixers.get(Number(feedback.options.mixer))?.opacity ?? null,
					Number(feedback.options.value) / 100,
				),
		},

		video_mixer_key_visible: {
			name: 'Video Mixer - Key Visible',
			description: 'True while luma-key opacity is above 0%.',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices }],
			callback: (feedback) => (self.processors.videoMixers.get(Number(feedback.options.mixer))?.opacity ?? 0) > 0.005,
		},

		video_mixer_key_inverted: {
			name: 'Video Mixer - Key Inverted',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [{ id: 'mixer', type: 'dropdown', label: 'Mixer', default: firstMixer, choices: mixerChoices }],
			callback: (feedback) => self.processors.videoMixers.get(Number(feedback.options.mixer))?.invert === true,
		},

		/** Router tally: is this exact source currently on this destination? */
		identify: {
			name: 'System - Identify Active',
			description: 'True while the front panel LED is blinking blue',
			type: 'boolean',
			defaultStyle: { bgcolor: BLUE, color: WHITE },
			options: [],
			callback: () => self.identifyActive,
		},

		ptp_locked: {
			name: 'PTP - Clock Locked',
			description: 'True only when the PTP clock is calibrated and locked',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [],
			callback: () => isPtpLocked(self.clocks.ptp),
		},

		genlock_in_use: {
			name: 'Genlock - In Use',
			description: 'True when the genlock instance has a time source assigned',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{
					id: 'genlock',
					type: 'dropdown',
					label: 'Genlock',
					default: 0,
					choices: [...self.clocks.genlocks.values()].map((g) => ({ id: g.index, label: g.name })),
				},
			],
			callback: (feedback) => self.clocks.genlocks.get(Number(feedback.options.genlock))?.timeSourcePath !== null,
		},

		flow_routed: {
			name: 'Flows - Source Routed To Destination',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'source', type: 'dropdown', label: 'Source', default: NO_SOURCE, choices: flowSources },
				{
					id: 'destination',
					type: 'dropdown',
					label: 'Destination',
					default: flowDestinations[0]?.id ?? '',
					choices: flowDestinations,
				},
				{ id: 'level', type: 'dropdown', label: 'Level', default: 'both', choices: ROUTE_LEVEL_CHOICES },
				sourceChannelOption(registry),
			],
			callback: (feedback) => {
				// Read fresh from `self.flowRegistry()` so the tally reflects the live IoState, not the
				// state as it was when the definitions were last registered.
				const destination = self.flowRegistry().destinations.get(String(feedback.options.destination))
				if (!destination) return false
				const wanted = String(feedback.options.source)
				const wantedChannel = Number(feedback.options.source_channel ?? 0)
				// "Video + Audio" tallies only when every chosen level agrees, so a breakaway does not
				// light up as though the whole destination follows one source.
				return levelsForOption(String(feedback.options.level)).every((level) => {
					const active = destination.active[level].sourceId
					// "(none)" is a real state to tally: the level is deliberately cleared.
					if (wanted === NO_SOURCE) return active === null
					if (active !== wanted) return false
					// A shuffler input follows one channel, so the same source on another channel is
					// not the route that was asked for.
					return !destination.takesChannel || destination.active[level].channel === wantedChannel
				})
			},
		},

		has_issues: {
			name: 'Health - Object Reporting Issues',
			description: 'True when the device reports an issue against the selected object, or against anything at all',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				{
					id: 'source',
					type: 'dropdown',
					label: 'Object',
					default: ANY_ISSUE_SOURCE,
					choices: issueChoices(self.issues),
				},
			],
			callback: (feedback) => {
				const wanted = String(feedback.options.source)
				if (wanted === ANY_ISSUE_SOURCE) return self.issues.active().length > 0
				return (self.issues.sources.get(wanted)?.flags.length ?? 0) > 0
			},
		},

		flow_breakaway: {
			name: 'Flows - Destination Is In Breakaway',
			description: 'True when the video and audio levels of a destination come from different sources',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [
				{
					id: 'destination',
					type: 'dropdown',
					label: 'Destination',
					default: flowDestinations[0]?.id ?? '',
					choices: flowDestinations,
				},
			],
			callback: (feedback) => isBreakaway(self.flowRegistry().destinations.get(String(feedback.options.destination))),
		},

		sdi_configuration: {
			name: 'SDI - I/O Configuration',
			description: 'True while the BNC is currently configured in the chosen direction',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'bnc', type: 'dropdown', label: 'BNC', default: firstBnc, choices: bncChoices },
				{
					id: 'direction',
					type: 'dropdown',
					label: 'Direction',
					default: 'Input',
					choices: [
						{ id: 'Input', label: 'Input' },
						{ id: 'Output', label: 'Output' },
					],
				},
			],
			callback: (feedback) =>
				self.io.state.bncs.get(Number(feedback.options.bnc))?.direction === feedback.options.direction,
		},

		sdi_input_locked: {
			name: 'SDI Input - Signal Locked',
			description: 'True when the input is locked to incoming data rather than falling back to the reference',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [{ id: 'input', type: 'dropdown', label: 'SDI input', default: firstInput, choices: inputChoices }],
			callback: (feedback) => isLocked(self.io.state.inputs.get(Number(feedback.options.input))),
		},

		sdi_input_black: {
			name: 'SDI Input - Is Black',
			description: 'True when the input is displaying a solid black image',
			type: 'boolean',
			defaultStyle: { bgcolor: BLACK, color: WHITE },
			options: [{ id: 'input', type: 'dropdown', label: 'SDI input', default: firstInput, choices: inputChoices }],
			callback: (feedback) => self.io.state.inputs.get(Number(feedback.options.input))?.black === true,
		},

		sdi_input_frozen: {
			name: 'SDI Input - Appears Frozen',
			description: 'True when the input is displaying a frozen image',
			type: 'boolean',
			defaultStyle: { bgcolor: AMBER, color: BLACK },
			options: [{ id: 'input', type: 'dropdown', label: 'SDI input', default: firstInput, choices: inputChoices }],
			callback: (feedback) => self.io.state.inputs.get(Number(feedback.options.input))?.frozen === true,
		},

		sdi_input_standard: {
			name: 'SDI Input - Video Standard',
			description: 'True when the input is displaying the selected video standard',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [
				{ id: 'input', type: 'dropdown', label: 'SDI input', default: firstInput, choices: inputChoices },
				{
					id: 'standard',
					type: 'dropdown',
					label: 'Standard',
					default: 'HD1080p50',
					choices: VAPI.Video.Enums.Standard.map((s) => ({ id: s, label: formatStandard(s) })),
				},
			],
			callback: (feedback) =>
				self.io.state.inputs.get(Number(feedback.options.input))?.standard === feedback.options.standard,
		},

		sdi_output_active: {
			name: 'SDI Output - Signal Active',
			description: 'True when the output has a routed source and a resolved video standard',
			type: 'boolean',
			defaultStyle: { bgcolor: GREEN, color: WHITE },
			options: [{ id: 'output', type: 'dropdown', label: 'SDI output', default: firstOutput, choices: outputChoices }],
			callback: (feedback) => {
				const output = self.io.state.outputs.get(Number(feedback.options.output))
				return !!output && output.videoSourcePath !== null && output.standard !== null
			},
		},

		sdi_output_issues: {
			name: 'SDI Output - Issue Present',
			description: 'True when the output reports any issue, or a specific one if selected',
			type: 'boolean',
			defaultStyle: { bgcolor: RED, color: WHITE },
			options: [
				{ id: 'output', type: 'dropdown', label: 'SDI output', default: firstOutput, choices: outputChoices },
				{
					id: 'issue',
					type: 'dropdown',
					label: 'Issue',
					default: 'any',
					choices: [
						{ id: 'any', label: 'Any issue' },
						...Object.entries(SDI_OUTPUT_ISSUE_LABELS).map(([id, label]) => ({ id, label })),
					],
				},
			],
			callback: (feedback) => {
				const issues = self.io.state.outputs.get(Number(feedback.options.output))?.issues ?? []
				return feedback.options.issue === 'any' ? issues.length > 0 : issues.includes(String(feedback.options.issue))
			},
		},
	})
}
