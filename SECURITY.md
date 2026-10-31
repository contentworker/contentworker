# Security policy

## Reporting a vulnerability

Report a vulnerability privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Please don't open a public issue, pull request or discussion
for it.

Include what you found, where (a URL, an endpoint or a file in this repository), how to reproduce
it, and what an attacker could do with it. A proof of concept helps, but keep it to the minimum
that shows the problem.

What to expect:

- An acknowledgement within 3 business days.
- An assessment (whether we can reproduce it, how severe it is, and what happens next) within 10
  business days.
- A fix, or a plan for one, before anything is made public. We'll agree a disclosure date with
  you, normally within 90 days of the report, and credit you in the advisory unless you'd rather
  not be named.

## Scope

In scope:

- This repository's code: the Workers (`apps/web`, the admin and its sign-in; `apps/api`, the
  Management and Preview APIs, MCP and OAuth; `apps/delivery`, the public Delivery API;
  `apps/engine`), the public SDKs, the shared packages and adapters, and the CI that builds and
  deploys them.
- Deployments operated by the maintainers on `contentworker.app` and its subdomains (for example
  `api.contentworker.app` and `cdn.contentworker.app`), within the rules below.

Out of scope: deployments run by third parties (report to their operator), denial of service and
load testing, social engineering of maintainers or users, physical attacks, and reports that only
come from automated scanners without a demonstrated impact.

## Testing rules

- Use only spaces, API keys and accounts you own or have written permission to test. Never
  access, change or delete another tenant's or space's content; if you reach data that isn't
  yours, stop, and tell us what you saw.
- Don't degrade the service: no high-volume scanning, no flooding of endpoints, webhooks or AI
  features (they spend real money).
- Don't point webhooks, functions or imports at systems you don't own.

We won't pursue legal action against research done in good faith under these rules, and we'll
treat it as authorized if anyone asks.

## Supported versions

contentworker is deployed from `main`; fixes ship to the latest release only. There are no older
versions to patch.
