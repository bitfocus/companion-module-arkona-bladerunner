import { combineRgb } from '@companion-module/base'
import * as VAPI from 'vapi'
import { isPtpLocked } from './clocks.js'
import { formatStandard, isLocked, SDI_OUTPUT_ISSUE_LABELS } from './io.js'
import type { ModuleInstance } from './main.js'
import {
	buildRegistry,
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
export function UpdateFeedbacks(self: ModuleInstance): void {
	const inputChoices = self.io.state.inputChoices()
	const outputChoices = self.io.state.outputChoices()
	const bncChoices = self.io.state.bncChoices()
	const firstInput = inputChoices[0]?.id ?? 0
	const firstOutput = outputChoices[0]?.id ?? 0
	const firstBnc = bncChoices[0]?.id ?? 0

	const registry = buildRegistry(self.flowState)
	const flowSources = sourceChoices(registry)
	const flowDestinations = destinationChoices(registry)

	self.setFeedbackDefinitions({
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
			],
			callback: (feedback) => {
				// Rebuilt per evaluation so the tally reflects the live IoState, not the state as it
				// was when the definitions were last registered.
				const destination = buildRegistry(self.flowState).destinations.get(String(feedback.options.destination))
				if (!destination) return false
				const wanted = String(feedback.options.source)
				// "Video + Audio" tallies only when every chosen level agrees, so a breakaway does not
				// light up as though the whole destination follows one source.
				return levelsForOption(String(feedback.options.level)).every((level) => {
					const active = destination.active[level].sourceId
					// "(none)" is a real state to tally: the level is deliberately cleared.
					return wanted === NO_SOURCE ? active === null : active === wanted
				})
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
			callback: (feedback) =>
				isBreakaway(buildRegistry(self.flowState).destinations.get(String(feedback.options.destination))),
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
