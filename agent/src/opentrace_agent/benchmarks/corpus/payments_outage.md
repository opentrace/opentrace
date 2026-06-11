# Postmortem: March 12 Outage

On March 12 the checkout service stopped accepting orders for 41 minutes.
The checkout service depends on the payments gateway for card
authorisation, and the payments gateway reads exchange rates from the
rates cache. When the rates cache evicted its hot keys during a deploy,
the payments gateway began timing out, and checkout requests queued up
behind it.

## Timeline

- 14:02 — deploy of the rates cache begins
- 14:07 — payments gateway p99 latency exceeds 30s
- 14:11 — checkout service circuit breaker opens
- 14:48 — full recovery

## Remediation

The March 12 outage was caused by the rates cache deploy. Going forward
the payments gateway will fall back to stale rates instead of timing out.
