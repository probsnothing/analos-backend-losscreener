type RetryOptions = {
  retries: number;
  factor: number;
  minTimeout: number;
  maxTimeout: number;
  onFailedAttempt: (err: Error) => void;
};

const defaultOpts: RetryOptions = {
  retries: 3,
  factor: 2,
  minTimeout: 1000,
  maxTimeout: 60000,
  onFailedAttempt: () => {},
};

export async function retry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {}
): Promise<T> {
  const { retries, factor, minTimeout, maxTimeout, onFailedAttempt } = {
    ...defaultOpts,
    ...opts,
  };
  let lastError: Error | undefined;

  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      onFailedAttempt(err);
      if (i < retries - 1) {
        const timeout = Math.min(maxTimeout, minTimeout * Math.pow(factor, i));
        await new Promise((resolve) => setTimeout(resolve, timeout));
      }
    }
  }
  throw lastError;
}
