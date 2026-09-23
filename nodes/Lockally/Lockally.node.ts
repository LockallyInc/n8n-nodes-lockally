import type {
	IDataObject,
	IExecuteFunctions,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import {
	compact,
	idempotencyKey,
	lockallyApiRequest,
	toAddressList,
} from './GenericFunctions';

export class Lockally implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Lockally',
		name: 'lockally',
		icon: { light: 'file:lockally.svg', dark: 'file:lockally.dark.svg' },
		group: ['output'],
		version: 1,
		// An AI agent can use this node as a tool: sending mail from a verified
		// address is exactly the kind of step an agent is asked to take.
		usableAsTool: true,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send email from your own domain and manage what Lockally sends',
		defaults: {
			name: 'Lockally',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'lockallyApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Email', value: 'email' },
					{ name: 'Message', value: 'message' },
					{ name: 'Suppression', value: 'suppression' },
				],
				default: 'email',
			},

			// ---------------------------------------------------------------- email
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['email'] } },
				options: [
					{
						name: 'Send',
						value: 'send',
						description: 'Send an email from one of your own addresses',
						action: 'Send an email',
					},
					{
						name: 'Send From Template',
						value: 'sendTemplate',
						description: 'Send a saved Lockally template, filling in its placeholders',
						action: 'Send an email from a template',
					},
					{
						name: 'Reply to Thread',
						value: 'reply',
						description: 'Reply inside an existing conversation so it stays one thread',
						action: 'Reply to an email thread',
					},
				],
				default: 'send',
			},
			{
				displayName: 'From',
				name: 'from',
				type: 'string',
				placeholder: 'hello@yourdomain.com',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['send', 'sendTemplate'] } },
				description:
					'An address on a domain you have verified in Lockally. Sending from an address Lockally does not own is refused.',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['send', 'sendTemplate'] } },
				description: 'One address, or several separated by commas',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				default: '',
				displayOptions: { show: { resource: ['email'], operation: ['send'] } },
			},
			{
				displayName: 'Body Type',
				name: 'bodyType',
				type: 'options',
				options: [
					{ name: 'Plain Text', value: 'text' },
					{ name: 'HTML', value: 'html' },
					{ name: 'Both', value: 'both' },
				],
				default: 'text',
				displayOptions: { show: { resource: ['email'], operation: ['send', 'reply'] } },
				description:
					'Sending both lets each mail app show the one it prefers, which is what most mail does',
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 5 },
				default: '',
				displayOptions: {
					show: { resource: ['email'], operation: ['send', 'reply'], bodyType: ['text', 'both'] },
				},
			},
			{
				displayName: 'HTML',
				name: 'html',
				type: 'string',
				typeOptions: { rows: 5 },
				default: '',
				displayOptions: {
					show: { resource: ['email'], operation: ['send', 'reply'], bodyType: ['html', 'both'] },
				},
			},
			{
				displayName: 'Template Name or ID',
				name: 'templateId',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getTemplates' },
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['sendTemplate'] } },
				description:
					'Templates are managed in the Lockally console. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName: 'Template Values',
				name: 'variables',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true },
				placeholder: 'Add value',
				default: {},
				displayOptions: { show: { resource: ['email'], operation: ['sendTemplate'] } },
				description: 'One row per placeholder. A template saying {{first_name}} takes a row named first_name.',
				options: [
					{
						name: 'value',
						displayName: 'Value',
						values: [
							{ displayName: 'Name', name: 'name', type: 'string', default: '' },
							{ displayName: 'Value', name: 'value', type: 'string', default: '' },
						],
					},
				],
			},
			{
				displayName: 'Thread ID',
				name: 'threadId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['email'], operation: ['reply'] } },
				description:
					'From a Lockally Trigger node. Needs the inboxes:write permission and a grant for that mailbox.',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['email'] } },
				options: [
					{
						displayName: 'Attachments',
						name: 'attachments',
						type: 'string',
						default: 'data',
						description:
							'Names of the binary properties on the incoming item to attach, separated by commas. Up to 10 MB each.',
					},
					{
						displayName: 'BCC',
						name: 'bcc',
						type: 'string',
						default: '',
						description: 'One address, or several separated by commas',
					},
					{
						displayName: 'CC',
						name: 'cc',
						type: 'string',
						default: '',
						description: 'One address, or several separated by commas',
					},
					{
						displayName: 'Marketing or Opt-in Email',
						name: 'unsubscribe',
						type: 'boolean',
						default: false,
						description:
							'Whether this is mail people signed up for, such as a newsletter. Lockally then adds a one-click unsubscribe header and skips anyone who unsubscribed. Leave off for transactional mail such as a receipt.',
					},
					{
						displayName: 'Send At',
						name: 'sendAt',
						type: 'dateTime',
						default: '',
						description: 'Leave empty to send now. A time in the future, up to 30 days ahead, schedules it.',
					},
					{
						displayName: 'Subject',
						name: 'subject',
						type: 'string',
						default: '',
						description: 'Leave empty to keep the conversation’s own subject',
					},
					{
						displayName: 'To',
						name: 'to',
						type: 'string',
						default: '',
						description:
							'Leave empty to reply to the people already in the conversation. One address, or several separated by commas.',
					},
				],
			},

			// ------------------------------------------------------------ suppression
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['suppression'] } },
				options: [
					{
						name: 'Add',
						value: 'add',
						description: 'Stop Lockally sending to an address',
						action: 'Add an address to the suppression list',
					},
					{
						name: 'Get',
						value: 'get',
						description: 'Check whether an address is suppressed, and why',
						action: 'Get a suppression',
					},
					{
						name: 'Remove',
						value: 'remove',
						description: 'Let Lockally send to an address again',
						action: 'Remove an address from the suppression list',
					},
				],
				default: 'add',
			},
			{
				displayName: 'Email',
				name: 'email',
				type: 'string',
				placeholder: 'someone@example.com',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['suppression'] } },
			},
			{
				displayName: 'Reason',
				name: 'reason',
				type: 'options',
				options: [
					{ name: 'Added by Hand', value: 'manual' },
					{ name: 'Mail to Them Bounced', value: 'bounce' },
					{ name: 'They Marked Mail as Spam', value: 'complaint' },
					{ name: 'They Unsubscribed', value: 'unsubscribe' },
				],
				default: 'manual',
				displayOptions: { show: { resource: ['suppression'], operation: ['add'] } },
				description:
					'A complaint or a bounce blocks every message to that address. An unsubscribe, or adding it by hand, blocks marketing and opt-in mail while letting transactional mail through.',
			},

			// --------------------------------------------------------------- message
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						name: 'Get',
						value: 'get',
						description: 'Look up an email you sent and where it got to',
						action: 'Get a sent message',
					},
				],
				default: 'get',
			},
			{
				displayName: 'Message ID',
				name: 'messageId',
				type: 'string',
				default: '',
				required: true,
				displayOptions: { show: { resource: ['message'] } },
				description: 'The ID a Send operation returned. Needs the send:read permission.',
			},
		],
	};

	methods = {
		loadOptions: {
			async getTemplates(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const response = await lockallyApiRequest.call(this, 'GET', '/v1/templates');
				return ((response.data as IDataObject[]) ?? []).map((t) => ({
					name: (t.name as string) || (t.id as string),
					value: t.id as string,
				}));
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let responseData: IDataObject = {};

				if (resource === 'email') {
					const options = this.getNodeParameter('options', i, {}) as IDataObject;

					if (operation === 'send' || operation === 'sendTemplate') {
						const to = toAddressList(this.getNodeParameter('to', i));
						if (to.length === 0) {
							throw new NodeOperationError(this.getNode(), 'This step has no recipient. Fill in To.', {
								itemIndex: i,
							});
						}

						const body: IDataObject = {
							from: String(this.getNodeParameter('from', i)).trim(),
							to,
							cc: toAddressList(options.cc),
							bcc: toAddressList(options.bcc),
							send_at: options.sendAt,
							unsubscribe: options.unsubscribe === true,
						};

						if (operation === 'send') {
							const bodyType = this.getNodeParameter('bodyType', i) as string;
							if (bodyType === 'text' || bodyType === 'both') {
								body.text = this.getNodeParameter('text', i, '');
							}
							if (bodyType === 'html' || bodyType === 'both') {
								body.html = this.getNodeParameter('html', i, '');
							}
							if (!body.text && !body.html) {
								throw new NodeOperationError(
									this.getNode(),
									'This step has no message. Fill in the body.',
									{ itemIndex: i },
								);
							}
							body.subject = this.getNodeParameter('subject', i, '');
						} else {
							body.template_id = this.getNodeParameter('templateId', i);
							body.variables = collectVariables(
								this.getNodeParameter('variables', i, {}) as IDataObject,
							);
						}

						const attachments = await buildAttachments.call(
							this,
							i,
							options.attachments as string | undefined,
						);
						if (attachments.length > 0) body.attachments = attachments;

						responseData = await lockallyApiRequest.call(
							this,
							'POST',
							'/v1/send',
							compact(body),
							{},
							{ 'Idempotency-Key': idempotencyKey() },
						);
					} else if (operation === 'reply') {
						const threadId = String(this.getNodeParameter('threadId', i)).trim();
						const bodyType = this.getNodeParameter('bodyType', i) as string;
						const body: IDataObject = {
							to: toAddressList(options.to),
							cc: toAddressList(options.cc),
							subject: options.subject,
						};
						if (bodyType === 'text' || bodyType === 'both') {
							body.text = this.getNodeParameter('text', i, '');
						}
						if (bodyType === 'html' || bodyType === 'both') {
							body.html = this.getNodeParameter('html', i, '');
						}
						if (!body.text && !body.html) {
							throw new NodeOperationError(this.getNode(), 'This step has no reply to send.', {
								itemIndex: i,
							});
						}
						responseData = await lockallyApiRequest.call(
							this,
							'POST',
							`/v1/threads/${threadId}/reply`,
							compact(body),
							{},
							{ 'Idempotency-Key': idempotencyKey() },
						);
					}
				} else if (resource === 'suppression') {
					const email = String(this.getNodeParameter('email', i)).trim();
					if (operation === 'add') {
						responseData = await lockallyApiRequest.call(this, 'POST', '/v1/suppressions', {
							email,
							reason: this.getNodeParameter('reason', i, 'manual'),
						});
					} else if (operation === 'remove') {
						await lockallyApiRequest.call(
							this,
							'DELETE',
							`/v1/suppressions/${encodeURIComponent(email)}`,
						);
						responseData = { email, removed: true };
					} else {
						responseData = await lockallyApiRequest.call(
							this,
							'GET',
							`/v1/suppressions/${encodeURIComponent(email)}`,
						);
					}
				} else if (resource === 'message') {
					const id = String(this.getNodeParameter('messageId', i)).trim();
					responseData = await lockallyApiRequest.call(
						this,
						'GET',
						`/v1/messages/${encodeURIComponent(id)}`,
					);
				}

				out.push({ json: responseData, pairedItem: { item: i } });
			} catch (error) {
				// "Continue on fail" exists so one bad address does not lose the
				// whole batch; the message travels with the item that caused it.
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// Re-raised as a node error so n8n shows which item failed, with
				// the wording the API or the check above already produced.
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [out];
	}
}

/** Template values arrive as rows of name and value; Lockally wants an object. */
function collectVariables(collection: IDataObject): IDataObject {
	const rows = (collection.value as IDataObject[]) ?? [];
	const out: IDataObject = {};
	for (const row of rows) {
		const name = String(row.name ?? '').trim();
		if (name) out[name] = row.value ?? '';
	}
	return out;
}

/**
 * Attachments come from the item's binary data, which is how every other n8n
 * node takes a file, so a Lockally step can follow a download or a form
 * upload without anything in between.
 */
async function buildAttachments(
	this: IExecuteFunctions,
	itemIndex: number,
	property: string | undefined,
): Promise<IDataObject[]> {
	if (!property) return [];
	const names = property
		.split(',')
		.map((n) => n.trim())
		.filter((n) => n.length > 0);
	const out: IDataObject[] = [];
	for (const name of names) {
		const binary = this.helpers.assertBinaryData(itemIndex, name);
		const buffer = await this.helpers.getBinaryDataBuffer(itemIndex, name);
		if (buffer.length > 10 * 1024 * 1024) {
			throw new NodeOperationError(
				this.getNode(),
				`The attachment in "${name}" is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. Lockally accepts up to 10 MB per attachment.`,
				{ itemIndex },
			);
		}
		out.push({
			filename: binary.fileName ?? name,
			content_type: binary.mimeType ?? 'application/octet-stream',
			content_base64: buffer.toString('base64'),
		});
	}
	return out;
}
