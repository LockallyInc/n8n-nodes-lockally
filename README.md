# n8n-nodes-lockally

Lockally nodes for [n8n](https://n8n.io): send email from your own domain as a
step in any workflow, and start workflows from the mail that arrives or from
what happens to mail you sent.

[Lockally](https://lockally.com) is business email on your own domain: real
mailboxes, a sending API, and webhooks.

## Installation

In n8n: **Settings**, then **Community nodes**, then **Install**, and enter
`n8n-nodes-lockally`. On self-hosted n8n you can also install it from npm in
your n8n folder.

## Credentials

Create an API key in the Lockally console on the **Tokens** page. It begins with
`lk_live_`. Give it only what the workflow needs:

| You want to | Permissions |
|---|---|
| Send email | `send:write` |
| Send a template | `send:write`, and `templates:read` for the dropdown |
| Start workflows from Lockally events | `webhooks:write` and `webhooks:read` |
| Trigger on mail arriving, or reply to a thread | `inboxes:read`, plus `inboxes:write` to reply |
| Manage the suppression list | `suppressions:write`, and `suppressions:read` to look one up |
| Look up a sent message | `send:read` |

**Mailboxes are granted separately.** A key sees only the mailboxes it is
granted, on the **API Keys** page of the console under the key's **Mailboxes**.
The Mailbox dropdown offers exactly those, and a trigger that asks for another one is refused rather than
quietly receiving nothing. A key with no mailbox grants cannot use the New Email
Received trigger at all; grant it the mailbox it should watch.

Triggers are built on Lockally webhooks, which are part of the paid plans.
Sending works on any plan with API access.

## Nodes

### Lockally Trigger

Starts a workflow on: **New Email Received** (optionally one mailbox), **Email
Delivered**, **Email Bounced**, **Spam Complaint**.

Turning the workflow on creates a webhook in Lockally pointed at it; turning the
workflow off deletes it. Nothing is left behind on either side. If the
subscription is removed in Lockally, the node notices and creates a new one
rather than listening to nothing.

### Lockally

| Resource | Operations |
|---|---|
| Email | Send, Send From Template, Reply to Thread |
| Suppression | Add, Get, Remove |
| Message | Get |

Attachments come from the item's binary data, so a Lockally step can follow a
download, an HTTP request or a form upload with nothing in between. Up to 10 MB
each.

The Lockally node is also available to AI agents as a tool.

## Example: answer support mail

1. **Lockally Trigger**, New Email Received, mailbox `support@yourdomain.com`.
2. An AI or logic step that decides on a reply.
3. **Lockally**, Email, Reply to Thread, with the trigger's `thread_id`.

The reply lands in the same conversation in the customer's mail app rather than
arriving as a new message.

## Compatibility

Tested against n8n's current node API (`n8nNodesApiVersion` 1) on Node 22. No
runtime dependencies.

## Development

```bash
npm install --ignore-scripts   # a transitive native dependency is not needed here
npm run lint
npm test                       # builds, then runs the tests against dist/
npm run dev                    # runs n8n locally with these nodes loaded
```

Releases publish from GitHub Actions with an npm provenance statement, which
n8n requires of community nodes.

## Resources

- [Lockally developer documentation](https://developers.lockally.com)
- [n8n community nodes](https://docs.n8n.io/integrations/community-nodes/)
- Support: support@lockally.com

## Licence

MIT, see [LICENSE](LICENSE).
