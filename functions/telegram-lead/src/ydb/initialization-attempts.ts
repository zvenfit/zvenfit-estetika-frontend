const initializationAttemptsKey = Symbol('ydbInitializationAttempts');

type InitializationError = Record<PropertyKey, unknown>;

function errorRecord(error: unknown): InitializationError | undefined {
  return error && typeof error === 'object' ? (error as InitializationError) : undefined;
}

export function recordInitializationAttempts(error: unknown, attempts: number): void {
  const record = errorRecord(error);
  if (!record || !Number.isInteger(attempts) || attempts < 1) {
    return;
  }

  try {
    Object.defineProperty(record, initializationAttemptsKey, {
      configurable: true,
      value: attempts,
    });
  } catch {
    // A frozen third-party error is still safe to rethrow; only the diagnostic field is lost.
  }
}

export function initializationAttempts(error: unknown): number | undefined {
  const attempts = errorRecord(error)?.[initializationAttemptsKey];

  return Number.isInteger(attempts) && Number(attempts) > 0 ? Number(attempts) : undefined;
}
