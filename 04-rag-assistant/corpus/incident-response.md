# Incident Response Runbook

## Severity levels

A SEV1 incident is a full production outage or a confirmed data breach affecting customers. A SEV2 incident is a major degradation of a core feature with a workaround available. A SEV3 incident is a minor issue with limited customer impact.

## Response times

The on-call engineer must acknowledge a SEV1 page and start responding within 15 minutes. SEV2 incidents must be acknowledged within 1 hour, and SEV3 incidents within the next business day. Pages are delivered through PagerDuty and escalate to the secondary on-call engineer after 10 minutes without acknowledgement.

## Roles

Every SEV1 and SEV2 incident has an incident commander who coordinates the response and makes decisions, a communications lead who writes the customer updates, and one or more responders who work on the fix. The commander should not debug the problem personally.

## Communication

During a SEV1 the public status page must be updated at least every 30 minutes, even when there is no new information. Customer-facing updates are written by the communications lead and reviewed by the incident commander. Internal updates are posted in the dedicated incident channel.

## Postmortems

A blameless postmortem must be published within 5 business days after a SEV1 or SEV2 incident is resolved. The postmortem includes a timeline, the root cause, customer impact, and action items with owners and due dates. Action items are tracked until completion.

## On-call rotation

On-call shifts last one week and rotate between engineers of each team. Engineers who were paged overnight receive a compensatory rest day.
