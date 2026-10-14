# Immediate Telegram delivery and independent retry

Status: approved for implementation, 2026-10-14.

## Decision

After durable persistence of a newly created submission, attempt delivery of that
specific notification in the HTTP invocation. Claim and Telegram POST share
an 8-second AbortSignal. Acknowledgement/failure writes retain their normal bounded
YDB timeout so an expired send deadline does not prevent recording a Telegram ack.
The browser success means durable acceptance; a delivery failure must not become
an HTTP storage error. Existing submissions do not bypass their retry backoff.

The HTTP path and all retry invocations use the same transactional claim and
2-minute lease. Successful deliveries leave the pending queue. Telegram has no
idempotency key for sendMessage: an ambiguous network outcome or failure to record
an acknowledgement can still produce a duplicate on a later retry. Never issue
an immediate second POST after an unknown result.

Keep the existing Yandex timer. Add an independent GitHub Actions schedule, every
five minutes with an offset from the start of the hour. It invokes the same worker
using the production environment's existing OIDC federation. No new long-lived
credentials, Telegram tokens, contacts or lead payloads are stored in GitHub.
The worker returns only delivery counters and queue age to this workflow.

The backup fails visibly on deferred processing, failed/pending attempts, malformed
responses, or an oldest pending age over 15 minutes. A green run requires an actual
worker result; HTTP 200 alone is insufficient. Workflow failure notifications use
the owner's GitHub Actions notification settings. Existing Monium queue alerts stay
in place. No claim is made that GitHub monitors its own missing schedule events.

## Limits and operation

- GitHub schedules are best effort, can be delayed/dropped, run from the default
  branch, and public repository schedules are disabled after 60 days of inactivity.
  Review the schedule's activity and re-enable it if GitHub disables it.
- The backup is independent of Yandex Triggers, but still needs Yandex authentication,
  Cloud Functions, YDB and Telegram. It is not multi-cloud persistence or a guarantee
  of delivery during a full Yandex outage.
- No dependency installation or YC CLI download is required for a backup invocation.
- `Telegram delivery backup` can be dispatched in GitHub Actions for an immediate
  recovery pass. Only the default branch and the original repository can execute it.
- Each run performs one worker invocation, without a blind retry on an ambiguous
  result. Another scheduled pass respects the existing lease and retry due time.
- To roll back, revert this change and deploy the previous code through the normal
  release pipeline; disable the backup workflow if rolling back its result contract.
  Never delete saved submissions or reset sent rows to replay a queue.

## Verification

Tests cover save-before-send, accepted responses after delivery failures, idempotent
reposts, competing timer/HTTP claims, cancellation before transmission, bounded
transport, deferred and stale queue reports, secret-free output and no blind retries.
Production acceptance requires both a real browser submission with recorded Telegram
acknowledgement and a GitHub backup run recovering an already pending notification.

Sources: [Cloud Functions execution model](https://yandex.cloud/en/docs/functions/concepts/function),
[GitHub schedule semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
