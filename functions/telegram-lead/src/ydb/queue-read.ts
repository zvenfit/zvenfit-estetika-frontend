import { isKnownTransientReadError } from './read-retry-policy';
import { QueueReadUnavailableError } from '../application/queue-read-unavailable';

// Translate provider failures at the adapter boundary, never in the handler.
export async function readQueue<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (isKnownTransientReadError(error)) {
      throw new QueueReadUnavailableError(error);
    }
    throw error;
  }
}
