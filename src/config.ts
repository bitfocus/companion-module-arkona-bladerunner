import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
	host: string
	port: number
	protocol: 'ws' | 'wss'
	username: string
	towel: string
}

export interface ModuleSecrets {
	password: string
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Blade IP',
			width: 6,
			regex: Regex.IP,
		},
		{
			type: 'number',
			id: 'port',
			label: 'Port',
			width: 3,
			min: 1,
			max: 65535,
			default: 80,
		},
		{
			type: 'dropdown',
			id: 'protocol',
			label: 'Protocol',
			width: 3,
			default: 'ws',
			choices: [
				{ id: 'ws', label: 'ws (http)' },
				{ id: 'wss', label: 'wss (https)' },
			],
		},
		{
			type: 'textinput',
			id: 'towel',
			label: 'Reservation Marker',
			description: 'Required for control commands to be accepted; optional for monitoring variables.',
			width: 12,
			default: 'Bitfocus-Connection',
			tooltip:
				'Shown in the Blade web UI to tell others who is using it. If another session already holds a reservation marker, use the same value to work alongside it.',
		},
		{
			type: 'static-text',
			id: 'auth-info',
			label: 'Authentication',
			width: 12,
			value: 'Only needed if the Blade is password protected. Leave blank otherwise.',
		},
		{
			type: 'textinput',
			id: 'username',
			label: 'Username',
			width: 6,
			default: '',
		},
		{
			type: 'secret-text',
			id: 'password',
			label: 'Password',
			width: 6,
			default: '',
		},
	]
}
