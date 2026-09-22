import type { CompanionVariableDefinition, DropdownChoice } from '@companion-module/base'
import type * as VScript from 'vscript'
import type { ModuleInstance } from './main.js'
import { watchKeyword, type Watchable } from './watch.js'

/**
 * The device's own health reporting.
 *
 * Nearly every object on a Blade - mixers, delays, players, receivers, streamers, the temperature
 * sensors - carries an `issues` keyword that lifts to a flat set of named booleans. They are all
 * the same shape, so one layer covers the whole device rather than each subscriber inventing its
 * own variable and feedback.
 */
export interface IssueSource {
	id: string
	label: string
	/** The flags currently raised, in the device's own wording. */
	flags: string[]
}

/** Any source in this group, for a feedback that lights on the device having any issue at all. */
export const ANY_ISSUE_SOURCE = '__any__'

export class IssueState {
	readonly sources = new Map<string, IssueSource>()

	/** Keep a source's label in step with a rename on the device. */
	relabel(id: string, label: string): void {
		const source = this.sources.get(id)
		if (source) source.label = label
	}

	/** Only the sources currently reporting something, which is what a tally cares about. */
	active(): IssueSource[] {
		return [...this.sources.values()].filter((s) => s.flags.length > 0)
	}

	/** Drop sources whose id starts with `prefix` and is no longer in `aliveIds`, e.g. after rediscovery. */
	retire(prefix: string, aliveIds: Set<string>): void {
		for (const id of this.sources.keys()) {
			if (id.startsWith(prefix) && !aliveIds.has(id)) this.sources.delete(id)
		}
	}

	clear(): void {
		this.sources.clear()
	}
}

/** Device keys stay in `SdiOutputState.issues` so feedbacks can match them. */
export const SDI_OUTPUT_ISSUE_LABELS: Record<string, string> = {
	std_mismatch: 'Standard mismatch',
	missing_t_src: 'Missing time source',
	different_genlocks: 'Different genlocks',
	no_12g_support: 'No 12G support',
	input_out_of_linephaser_range: 'Input out of linephaser range',
}

/** `{ std_mismatch: true, no_12g_support: false }` -> `['std_mismatch']`. */
export function activeIssues(issues: Record<string, unknown> | null | undefined): string[] {
	if (!issues) return []
	return Object.entries(issues)
		.filter(([, v]) => v === true)
		.map(([k]) => k)
}

/** `['missing_t_src', 'std_mismatch']` -> `'Missing time source, Standard mismatch'`. */
export function formatIssueLabels(issues: string[]): string {
	return issues.map(formatIssueLabel).join(', ')
}

export function formatIssueLabel(key: string): string {
	return SDI_OUTPUT_ISSUE_LABELS[key] ?? humanizeSnakeCase(key)
}

function humanizeSnakeCase(key: string): string {
	const trimmed = key.trim()
	if (!trimmed) return trimmed
	const spaced = trimmed.replaceAll('_', ' ')
	return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function issueVariable(id: string): string {
	return `issues_${id}`
}

/**
 * Subscribe one object's issues.
 *
 * Registers the source even before the first value arrives, so its variables exist and a feedback
 * can name it whether or not the device is currently unhappy about it.
 */
/**
 * Record what an object is currently reporting.
 *
 * Separate from `watchIssues` because the SDI ports arrive through their own watch, which already
 * publishes its own variable and feedback - they still belong in the device-wide picture.
 */
export function reportIssues(self: ModuleInstance, id: string, label: string, flags: string[]): void {
	const existing = self.issues.sources.get(id)
	if (existing) {
		existing.label = label
		existing.flags = flags
	} else {
		self.issues.sources.set(id, { id, label, flags })
	}
	publishIssues(self)
	self.checkFeedbacks('has_issues')
}

export async function watchIssues(
	self: ModuleInstance,
	id: string,
	label: string,
	keyword: Watchable<unknown>,
	collect: (watcher: VScript.Watcher) => void,
): Promise<void> {
	const state = self.issues
	const entry: IssueSource = { id, label, flags: [] }
	state.sources.set(id, entry)
	return watchKeyword(
		self,
		`${id}.issues`,
		keyword,
		// The lifted payload is a flat record of named booleans; the raised ones are the report.
		(v) => reportIssues(self, id, entry.label, activeIssues(v as Record<string, unknown> | null)),
		collect,
	)
}

/** Publish every issue variable. One source changing changes the device-wide summary too. */
export function publishIssues(self: ModuleInstance): void {
	const batcher = self.variables
	for (const source of self.issues.sources.values()) {
		batcher.set(issueVariable(source.id), formatIssueLabels(source.flags))
		batcher.set(`${issueVariable(source.id)}_count`, source.flags.length)
	}
	const active = self.issues.active()
	batcher.set(
		'issues_count',
		active.reduce((n, s) => n + s.flags.length, 0),
	)
	batcher.set('issues_sources', active.map((s) => s.label).join(', '))
}

export function IssueVariableDefinitions(state: IssueState): CompanionVariableDefinition[] {
	return [
		{ variableId: 'issues_count', name: 'Issues - Total Reported' },
		{ variableId: 'issues_sources', name: 'Issues - Objects Reporting' },
		...[...state.sources.values()].flatMap((source) => [
			{ variableId: issueVariable(source.id), name: `Issues - ${source.label}` },
			{ variableId: `${issueVariable(source.id)}_count`, name: `Issues - ${source.label} Count` },
		]),
	]
}

export function issueChoices(state: IssueState): DropdownChoice[] {
	return [
		{ id: ANY_ISSUE_SOURCE, label: '(anything on the device)' },
		...[...state.sources.values()].map((s) => ({ id: s.id, label: s.label })),
	]
}
