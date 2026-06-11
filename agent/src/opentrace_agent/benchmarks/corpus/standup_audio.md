# Audio transcript (standup-2026-05-04.m4a)

[00:00:03] Priya Nair: Morning everyone. Um, quick update from me — the
release of Relay 3.0 went out yesterday, uh, no rollbacks needed.

[00:00:19] Priya Nair: Relay 3.0 replaces the old fan-out worker, so
once we, you know, confirm the queue drains we can decommission it.

[00:00:41] Tom Okafor: Nice. I'm still on the flaky integration tests,
nothing, uh, nothing worth reporting yet.

[00:00:58] Priya Nair: Cool. Oh — one more thing, the fan-out worker
still writes to the metrics sink, so keep that running until the
cutover is done.

[00:01:12] Speaker 3: (inaudible)

[00:01:15] Priya Nair: Yeah, exactly. Okay, that's everyone, thanks.
