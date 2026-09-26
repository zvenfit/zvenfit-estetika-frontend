// Storage-port failure: a read could not complete, but no queue state changed.
// Adapters may use this only for a positively identified transient read failure.
export class QueueReadUnavailableError extends Error {
  public constructor(cause: unknown) {
    super('Notification queue read temporarily unavailable', { cause });
    this.name = 'QueueReadUnavailableError';
  }
}
