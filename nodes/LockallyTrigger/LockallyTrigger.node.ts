import type {
	IDataObject,
	IHookFunctions,
	ILoadOptionsFunctions,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { flattenEvent, lockallyApiRequest, MAILBOX_EVENTS } from '../Lockally/GenericFunctions';

export class LockallyTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Lockally Trigger',
		name: 'lockallyTrigger',
		icon: { light: 'file:lockally.svg', dark: 'file:lockally.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when something happens in Lockally',
		defaults: {
			name: 'Lockally Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'lockallyApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['message.received'],
				description: 'The Lockally events this workflow should start on',
				options: [
					{
						name: 'Email Bounced',
						value: 'delivery.bounced',
						description: 'An email you sent bounced, with the reason the receiving server gave',
					},
					{
						name: 'Email Delivered',
						value: 'delivery.delivered',
						description: "An email you sent was accepted by the recipient's mail server",
					},
					{
						name: 'New Email Received',
						value: 'message.received',
						description: 'Mail arrived in a Lockally mailbox',
					},
					{
						name: 'Spam Complaint',
						value: 'delivery.complaint',
						description: 'Somebody marked your mail as spam and their provider reported it',
					},
				],
			},
			{
				displayName: 'Mailbox Name or ID',
				name: 'mailbox',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getMailboxes' },
				default: '',
				displayOptions: { show: { events: ['message.received'] } },
				description:
					'Which mailbox to watch. Leave empty for every mailbox this API key can see, which for a key limited to certain mailboxes means exactly those. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
			},
			{
				displayName:
					'Turning this workflow on creates a webhook in Lockally, and turning it off deletes it. Triggers need a plan that includes webhooks.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
		],
	};

	methods = {
		loadOptions: {
			async getMailboxes(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				// The mailboxes this key may actually see. A key with mailbox
				// grants gets exactly its granted ones, so the list never offers
				// a mailbox the trigger would then be refused.
				const response = await lockallyApiRequest.call(this, 'GET', '/v1/inboxes');
				return ((response.inboxes as IDataObject[]) ?? []).map((inbox) => ({
					name: inbox.email as string,
					value: inbox.email as string,
				}));
			},
		},
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (!webhookData.webhookId) return false;

				// Lockally is the record of what exists. If the subscription was
				// deleted there (or the account was rebuilt), n8n must create a
				// new one rather than trust its own note of it.
				const response = await lockallyApiRequest.call(this, 'GET', '/v1/webhooks');
				const found = ((response.data as IDataObject[]) ?? []).some(
					(w) => w.id === webhookData.webhookId,
				);
				if (!found) {
					delete webhookData.webhookId;
					return false;
				}
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				if (events.length === 0) {
					throw new NodeOperationError(this.getNode(), 'Choose at least one event to listen for.');
				}

				const body: IDataObject = { url: webhookUrl, events };

				// Naming no mailbox means "every mailbox this key can see": with a
				// key that has mailbox grants Lockally fills in exactly those, and
				// a key with none is refused with a message saying how to grant
				// them, rather than being left subscribed to nothing.
				const mailbox = (this.getNodeParameter('mailbox', '') as string).trim();
				if (mailbox && events.some((e) => MAILBOX_EVENTS.includes(e))) {
					body.mailboxes = [mailbox];
				}

				const created = await lockallyApiRequest.call(this, 'POST', '/v1/webhooks', body);
				if (!created?.id) {
					throw new NodeOperationError(this.getNode(), 'Lockally did not return a webhook to listen on.');
				}

				const webhookData = this.getWorkflowStaticData('node');
				webhookData.webhookId = created.id as string;
				// Kept so the signature can be checked later without asking
				// Lockally again; it is shown only once, when the webhook is made.
				webhookData.signingSecret = created.signing_secret as string;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const webhookData = this.getWorkflowStaticData('node');
				if (!webhookData.webhookId) return true;
				try {
					await lockallyApiRequest.call(this, 'DELETE', `/v1/webhooks/${webhookData.webhookId}`);
				} catch (error) {
					// A subscription that is already gone is the state we wanted, and
					// failing here would leave somebody unable to turn their own
					// workflow off. It is still worth saying so in the log, because
					// the other reason this fails is a key that lost its permission,
					// which leaves a live subscription behind in Lockally.
					this.logger.warn(
						`Lockally: could not delete webhook ${webhookData.webhookId as string}: ${(error as Error).message}`,
					);
				}
				delete webhookData.webhookId;
				delete webhookData.signingSecret;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const event = flattenEvent(this.getBodyData() as IDataObject);
		if (!event) {
			// Something that is not a Lockally event reached this URL. Answering
			// 200 and starting nothing is right: the sender learns nothing, and
			// the workflow does not run on a body it cannot read.
			return { webhookResponse: { received: true } };
		}
		return {
			workflowData: [this.helpers.returnJsonArray([event])],
		};
	}
}
