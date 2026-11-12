import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class LockallyApi implements ICredentialType {
	name = 'lockallyApi';

	icon = { light: 'file:lockally.svg', dark: 'file:lockally.dark.svg' } as const;

	displayName = 'Lockally API';

	documentationUrl = 'https://developers.lockally.com/getting-started/authentication/';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description:
				'Create it in the Lockally console on the Tokens page. It starts with lk_live_. Give it the permissions this workflow needs: send:write to send, webhooks:read and webhooks:write for triggers, inboxes:read to read mailboxes, suppressions:write for the suppression list. To trigger on mail arriving in a mailbox, grant the key that mailbox on the API Keys page, under the key’s Mailboxes. A key sees only the mailboxes it is granted.',
		},
		{
			displayName: 'API URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.lockally.com',
			description: 'Change only if Lockally told you to, such as for a private deployment',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Checking the key against whoami rather than something heavier: it is the
	// cheapest call that proves the key is real, and it names the account, so a
	// wrong key fails here rather than in the middle of somebody's workflow.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/v1/auth/whoami',
		},
	};
}
