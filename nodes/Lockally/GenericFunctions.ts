import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export type LockallyFunctions =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IWebhookFunctions;

/** The events Lockally sends that are about one mailbox rather than the account. */
export const MAILBOX_EVENTS = ['message.received', 'mailbox.quota_warning', 'mailbox.quota_full'];

/**
 * One call to Lockally.
 *
 * Errors come back as RFC 9457 problem details, whose `title` and `detail` are
 * already written for a person to read. We pass those through and add what to
 * do next, because n8n shows this message on the node and nowhere else.
 */
export async function lockallyApiRequest(
	this: LockallyFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	headers: IDataObject = {},
): Promise<IDataObject> {
	const credentials = await this.getCredentials('lockallyApi');
	const baseUrl = ((credentials.baseUrl as string) || 'https://api.lockally.com').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${endpoint}`,
		headers: { 'Content-Type': 'application/json', ...headers },
		json: true,
	};
	if (Object.keys(body).length > 0) options.body = body;
	if (Object.keys(qs).length > 0) options.qs = qs;

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'lockallyApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject, {
			message: apiErrorMessage(error as JsonObject, endpoint),
		});
	}
}

/** The sentence somebody should read when Lockally refuses. */
export function apiErrorMessage(error: JsonObject, endpoint: string): string {
	const response = (error.response ?? {}) as JsonObject;
	const problem = ((response.body ?? error.error ?? {}) as JsonObject) ?? {};
	const status = (error.httpCode ?? response.statusCode ?? '') as string | number;
	const title = (problem.title as string) || 'Lockally refused the request';
	const detail = (problem.detail as string) || '';
	const said = detail ? `${title}. ${detail}` : title;

	if (String(status) === '401') {
		return `${said} Check the API key on this node’s credential.`;
	}
	if (String(status) === '403' || String(status) === '402') {
		if (problem.reason === 'plan' || /upgrade|plan/i.test(title)) {
			return `${said} Open Billing in the Lockally console to change plan.`;
		}
		const scope = scopeFor(endpoint);
		return scope
			? `${said} This key needs the ${scope} permission. Create a new key with it on the Tokens page of the Lockally console, then put the new key in this node’s credential. A new key has no mailboxes until you grant them on the API Keys page.`
			: said;
	}
	if (String(status) === '429') {
		return `${said} Lockally is rate limiting this account; slow the workflow down or try again shortly.`;
	}
	return said;
}

/** Which permission a path needs, for the message above. */
function scopeFor(endpoint: string): string | null {
	if (endpoint.startsWith('/v1/send')) return 'send:write';
	if (endpoint.startsWith('/v1/webhooks')) return 'webhooks:write';
	if (endpoint.startsWith('/v1/events')) return 'webhooks:read';
	if (endpoint.startsWith('/v1/inboxes')) return 'inboxes:read';
	if (endpoint.startsWith('/v1/threads')) return 'inboxes:write';
	if (endpoint.startsWith('/v1/suppressions')) return 'suppressions:write';
	if (endpoint.startsWith('/v1/messages')) return 'send:read';
	if (endpoint.startsWith('/v1/templates')) return 'templates:read';
	return null;
}

/**
 * Turn a Lockally event envelope into the flat item a workflow works with.
 *
 * The webhook body and a row from GET /v1/events are the same envelope, so
 * both paths go through here and a workflow built against one behaves the same
 * on the other.
 */
export function flattenEvent(envelope: IDataObject | undefined): IDataObject | null {
	if (!envelope || typeof envelope !== 'object' || !envelope.type) return null;
	const data = (envelope.data as IDataObject) ?? {};
	return {
		id: envelope.id,
		event: envelope.type,
		occurred_at: envelope.created
			? new Date((envelope.created as number) * 1000).toISOString()
			: undefined,
		...data,
	};
}

/** The header Lockally signs every webhook delivery with. */
export const SIGNATURE_HEADER = 'x-lockally-signature';

/** How old a signed timestamp may be before the delivery is refused as a replay. */
export const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

/**
 * Check a Lockally webhook signature. Returns null when it is good, or the
 * reason it is not.
 *
 * This mirrors the server (internal/webhook/sign.go in Lockally): the header is
 * `t=<unix seconds>,v1=<hex>`, and v1 is HMAC-SHA256 over `t + "." + raw body`,
 * keyed with the raw bytes the hex `signing_secret` decodes to (not the hex text
 * itself). It must be the raw body: JSON parsed and serialised again is not
 * byte for byte what Lockally signed.
 */
export function verifyWebhookSignature(
	secretHex: string,
	rawBody: Buffer,
	header: string | undefined,
	nowSeconds: number,
): string | null {
	if (!header) return 'missing signature header';

	let ts = '';
	let sig = '';
	for (const part of header.split(',')) {
		const trimmed = part.trim();
		const eq = trimmed.indexOf('=');
		if (eq < 0) return 'malformed signature header';
		const key = trimmed.slice(0, eq);
		const value = trimmed.slice(eq + 1);
		if (key === 't') ts = value;
		else if (key === 'v1') sig = value;
	}
	if (!ts || !sig) return 'malformed signature header';
	if (!/^\d+$/.test(ts)) return 'malformed signature timestamp';
	if (nowSeconds - Number(ts) > SIGNATURE_MAX_AGE_SECONDS) return 'signature timestamp too old';
	if (!isHex(sig)) return 'malformed signature';
	if (!isHex(secretHex)) return 'stored signing secret is not valid';

	const want = createHmac('sha256', Buffer.from(secretHex, 'hex'))
		.update(`${ts}.`)
		.update(rawBody)
		.digest();
	const got = Buffer.from(sig, 'hex');
	if (got.length !== want.length || !timingSafeEqual(got, want)) return 'signature mismatch';
	return null;
}

function isHex(value: string): boolean {
	return value.length > 0 && value.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(value);
}

/** Addresses, however they were supplied: a list, or one string of them. */
export function toAddressList(value: unknown): string[] {
	if (value === undefined || value === null || value === '') return [];
	const parts = Array.isArray(value) ? value : String(value).split(/[,\n;]+/);
	return parts.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

/** Leave out what Lockally would rather not receive empty. */
export function compact(obj: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value === undefined || value === null || value === '') continue;
		if (Array.isArray(value) && value.length === 0) continue;
		out[key] = value;
	}
	return out;
}

/**
 * Lockally requires an Idempotency-Key on every send and replays the first
 * answer for 24 hours.
 *
 * A fresh key per execution is deliberate. Deriving it from the message would
 * mean a workflow that legitimately sends the same message twice in a day
 * silently sends it once, and reports success both times.
 */
export function idempotencyKey(): string {
	return randomUUID();
}

export function requireOneOf(
	node: LockallyFunctions,
	itemIndex: number,
	values: Record<string, unknown>,
	message: string,
): void {
	if (Object.values(values).every((v) => v === undefined || v === null || v === '')) {
		throw new NodeOperationError(node.getNode(), message, { itemIndex });
	}
}
