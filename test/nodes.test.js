'use strict';

// Runs against the built output, which is what n8n actually loads.
// `npm run build` first.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
	apiErrorMessage,
	compact,
	flattenEvent,
	toAddressList,
	MAILBOX_EVENTS,
} = require('../dist/nodes/Lockally/GenericFunctions.js');
const { Lockally } = require('../dist/nodes/Lockally/Lockally.node.js');
const { LockallyTrigger } = require('../dist/nodes/LockallyTrigger/LockallyTrigger.node.js');
const { LockallyApi } = require('../dist/credentials/LockallyApi.credentials.js');

test('an event looks the same from the webhook and from the event log', () => {
	const envelope = {
		id: 'evt_1',
		type: 'message.received',
		created: 1789234567,
		tenant_id: 't',
		data: { mailbox: 'sales@acme.test', subject: 'Hello', from: 'someone@example.test' },
	};

	const flat = flattenEvent(envelope);
	assert.equal(flat.id, 'evt_1', 'the envelope id is what dedupes an event');
	assert.equal(flat.event, 'message.received');
	assert.equal(flat.mailbox, 'sales@acme.test');
	assert.equal(flat.subject, 'Hello');
	assert.equal(flat.occurred_at, new Date(1789234567000).toISOString());

	// The same function reads both paths, so they cannot drift apart.
	assert.deepEqual(flattenEvent(envelope), flat);
});

test('something that is not an event is ignored rather than started on', () => {
	assert.equal(flattenEvent(undefined), null);
	assert.equal(flattenEvent({}), null);
	assert.equal(flattenEvent({ hello: 'world' }), null);
});

test('addresses arrive as a list or as one typed string', () => {
	assert.deepEqual(toAddressList('a@x.test, b@x.test'), ['a@x.test', 'b@x.test']);
	assert.deepEqual(toAddressList(['a@x.test', '', ' b@x.test ']), ['a@x.test', 'b@x.test']);
	assert.deepEqual(toAddressList('a@x.test\nb@x.test;c@x.test'), ['a@x.test', 'b@x.test', 'c@x.test']);
	assert.deepEqual(toAddressList(''), []);
	assert.deepEqual(toAddressList(undefined), []);
});

test('empty fields are left out rather than sent empty', () => {
	assert.deepEqual(compact({ a: 1, b: '', c: [], d: null, e: 'keep' }), { a: 1, e: 'keep' });
});

test('a refusal is turned into something the person can act on', () => {
	const scope = apiErrorMessage(
		{ httpCode: '403', response: { body: { title: 'Insufficient scope', detail: 'This endpoint requires scope: send:write' } } },
		'/v1/send',
	);
	assert.match(scope, /send:write permission/);

	const plan = apiErrorMessage(
		{ httpCode: '403', response: { body: { title: 'Upgrade required', detail: 'Webhooks require a paid plan.', reason: 'plan' } } },
		'/v1/webhooks',
	);
	assert.match(plan, /Billing/);

	const key = apiErrorMessage({ httpCode: '401', response: { body: { title: 'Invalid API key' } } }, '/v1/send');
	assert.match(key, /API key/);

	// Nothing recognisable still produces a sentence rather than "undefined".
	assert.match(apiErrorMessage({}, '/v1/send'), /Lockally refused/);
});

test('the trigger subscribes and unsubscribes, and knows what it is listening to', () => {
	const trigger = new LockallyTrigger();
	const methods = trigger.webhookMethods.default;
	for (const name of ['checkExists', 'create', 'delete']) {
		assert.equal(typeof methods[name], 'function', `${name} is part of the webhook lifecycle`);
	}

	const events = trigger.description.properties.find((p) => p.name === 'events');
	const offered = events.options.map((o) => o.value);
	assert.deepEqual(
		offered.slice().sort(),
		['delivery.bounced', 'delivery.complaint', 'delivery.delivered', 'message.received'],
	);

	// The mailbox picker only appears for the event that is about a mailbox.
	const mailbox = trigger.description.properties.find((p) => p.name === 'mailbox');
	assert.deepEqual(mailbox.displayOptions.show.events, ['message.received']);
	assert.ok(MAILBOX_EVENTS.includes('message.received'));
});

test('the nodes declare what n8n needs to load them', () => {
	for (const node of [new Lockally(), new LockallyTrigger()]) {
		const d = node.description;
		assert.equal(d.credentials[0].name, 'lockallyApi');
		assert.ok(d.icon.light && d.icon.dark, 'both themes have an icon');
		assert.ok(d.description.length > 0);
	}
	assert.equal(new Lockally().description.usableAsTool, true);
});

test('the credential is tested against the cheapest call that proves the key', () => {
	const cred = new LockallyApi();
	assert.equal(cred.name, 'lockallyApi');
	assert.equal(cred.test.request.url, '/v1/auth/whoami');
	assert.match(cred.authenticate.properties.headers.Authorization, /Bearer/);
	// The key must never be stored in the clear in the n8n UI.
	const apiKey = cred.properties.find((p) => p.name === 'apiKey');
	assert.equal(apiKey.typeOptions.password, true);
});
