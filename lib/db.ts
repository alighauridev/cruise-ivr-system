import { neon, NeonQueryFunction } from '@neondatabase/serverless';

const sqlBase = neon(process.env.DATABASE_URL!);

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('Connect Timeout') || msg.includes('fetch failed') || msg.includes('UND_ERR_CONNECT_TIMEOUT');
    if (isTimeout) {
      console.warn('[DB] Connection timeout, retrying in 2s...');
      await new Promise((r) => setTimeout(r, 2000));
      return await fn();
    }
    throw err;
  }
}

// Tagged template wrapper with retry
const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
  withRetry(() => sqlBase(strings, ...values))) as unknown as NeonQueryFunction<false, false>;

export { sql };
export default sql;
