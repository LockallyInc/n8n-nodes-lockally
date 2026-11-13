'use strict';

// Webhook signature checks on the Lockally Trigger. Runs against dist/, like
// the other tests. Signatures here are computed exactly as Lockally's
// dispatcher does (internal/webhook/sign.go): HMAC-SHA256 over
// `t + "." + raw body`, keyed with the raw secret bytes, hex encoded, sent as
// `X-Lockally-Signature: t=<unix>,v1=<hex>`. The API hands the secret out hex
// encoded, and that hex string is what the trigger stores.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { verifyWebhookSignature } = require('../dist/nodes/Lockally/GenericFunctions.js');
const { LockallyTrigger } = require('../dist/nodes/LockallyTrigger/LockallyTrigger.node.js');

const secretBytes = crypto.randomBytes(32);
const secretHex = secretBytes.toString('hex');

const envelope = {
	id: 'evt_1',
	type: 'message.received',
	created: 1789234567,
	tenant_id: 't',
	data: { mailbox: 'sales@acme.test', subject: 'Hello' },
};
const rawBody = Buffer.from(JSON.stringify(envelope), 'utf8');

function sign(body, t, key = secretBytes) {
	const mac = crypto.createHmac('sha256', key).update(`${t}.`).update(body).digest('hex');
	return `t=${t},v1=${mac}`;
}

const now = () => Math.floor(Date.now() / 1000);

/** A stand-in for n8n's webhook context, recording what the node did. */
function context({ secret, header, body = rawBody }) {
	const staticData = secret === undefined ? {} : { signingSecret: secret };
	const record = { status: null, json: null, warnings: [] };
	const headers = { 'content-type': 'application/json' };
	if (header !== undefined) headers['x-lockally-signature'] = header;
	const res = {
		status(code) {
			record.status = code;
			return res;
		},
		json(value) {
			record.json = value;
			return res;
		},
	};
	const ctx = {
		getWorkflowStaticData: () => staticData,
		getHeaderData: () => headers,
		getRequestObject: () => ({ rawBody: body, headers }),
		getResponseObject: () => res,
		getBodyData: () => JSON.parse(body.toString('utf8')),
		getNode: () => ({ name: 'Lockally Trigger' }),
		logger: {
			warn: (msg) => record.warnings.push(msg),
			info() {},
			debug() {},
			error() {},
		},
		helpers: { returnJsonArray: (items) => items.map((json) => ({ json })) },
	};
	return { ctx, record };
}

async function deliver(opts) {
	const { ctx, record } = context(opts);
	const result = await new LockallyTrigger().webhook.call(ctx);
	return { result, record };
}

function assertStarted({ result, record }) {
	assert.equal(record.status, null, 'nothing was refused');
	assert.ok(result.workflowData, 'the workflow starts');
	assert.equal(result.workflowData[0][0].json.id, 'evt_1');
}

function assertRefused({ result, record }) {
	assert.equal(record.status, 401);
	assert.equal(result.workflowData, undefined, 'the workflow does not start');
	assert.equal(result.noWebhookResponse, true, 'the 401 is the whole answer');
	assert.ok(record.warnings.length > 0, 'the refusal is logged');
}

test('matches a signature made by the Lockally server itself', () => {
	// Produced by Lockally's own webhook.Sign (Go) for this secret, body and
	// time, so this pins the scheme across languages, including a non-ASCII
	// body and the characters Go's JSON encoder would escape.
	const goSecret = '8f1c2a3b4d5e6f708192a3b4c5d6e7f80112233445566778899aabbccddeeff0';
	const goBody = Buffer.from(
		'{"id":"evt_vec","type":"message.received","created":1789234567,"tenant_id":"t","data":{"mailbox":"sales@acme.test","subject":"Café <hi> & bye"}}',
		'utf8',
	);
	const goHeader =
		't=1789234567,v1=5c029810054ce004c31fcf40854e98c58c380ae2eb19e194e6fdd4c8823fc920';
	assert.equal(verifyWebhookSignature(goSecret, goBody, goHeader, 1789234567), null);
	assert.equal(
		verifyWebhookSignature(goSecret, Buffer.concat([goBody, Buffer.from(' ')]), goHeader, 1789234567),
		'signature mismatch',
		'one byte more is a different body',
	);
});

test('a correctly signed delivery starts the workflow', async () => {
	assertStarted(await deliver({ secret: secretHex, header: sign(rawBody, now()) }));
});

test('a wrong signature is refused', async () => {
	const other = crypto.randomBytes(32);
	assertRefused(await deliver({ secret: secretHex, header: sign(rawBody, now(), other) }));
});

test('a signature over a different body is refused', async () => {
	const header = sign(rawBody, now());
	const tampered = Buffer.from(rawBody.toString('utf8').replace('Hello', 'Hellp'), 'utf8');
	assertRefused(await deliver({ secret: secretHex, header, body: tampered }));
});

test('the secret is the bytes the hex decodes to, not the hex text', async () => {
	const header = sign(rawBody, now(), Buffer.from(secretHex, 'utf8'));
	assertRefused(await deliver({ secret: secretHex, header }));
});

test('a timestamp older than five minutes is refused', async () => {
	const t = now() - 5 * 60 - 1;
	assertRefused(await deliver({ secret: secretHex, header: sign(rawBody, t) }));
	assert.equal(verifyWebhookSignature(secretHex, rawBody, sign(rawBody, t), t + 301), 'signature timestamp too old');
	assert.equal(verifyWebhookSignature(secretHex, rawBody, sign(rawBody, t), t + 300), null);
});

test('a missing signature header is refused', async () => {
	assertRefused(await deliver({ secret: secretHex }));
	assertRefused(await deliver({ secret: secretHex, header: '' }));
});

test('a malformed signature header is refused', async () => {
	const t = now();
	for (const header of [
		'garbage',
		`t=${t}`,
		'v1=abcd',
		`t=soon,v1=${'0'.repeat(64)}`,
		`t=${t},v1=not-hex`,
		`t=${t},v1=abc`,
		`t=${t},v1=${'0'.repeat(62)}`,
	]) {
		assertRefused(await deliver({ secret: secretHex, header }));
	}
});

test('a webhook with no stored secret still works, with a warning', async () => {
	const out = await deliver({});
	assertStarted(out);
	assert.match(out.record.warnings[0], /no stored signing secret/);
});
