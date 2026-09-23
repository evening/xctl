import type { Page, Response } from 'playwright-core';
import { log } from './log.js';

export interface Captured {
  op: string;
  variables: Record<string, unknown>;
  status: number;
  json: any;
}

/**
 * Record X GraphQL responses for one operation name (e.g. "TweetDetail") on a page.
 * Register before navigating.
 */
export function captureGraphql(page: Page, op: string, filter?: (vars: Record<string, unknown>) => boolean) {
  const results: Captured[] = [];
  const rateLimited: number[] = [];
  let notify: (() => void) | null = null;
  const re = new RegExp(`/graphql/[^/]+/${op}(\\?|$)`);
  const pending = new Set<Promise<void>>();

  const handler = (resp: Response) => {
    const url = resp.url();
    if (!re.test(url)) return;
    const p = (async () => {
      let variables: Record<string, unknown> = {};
      try {
        const v = new URL(url).searchParams.get('variables');
        if (v) variables = JSON.parse(v);
        else variables = (resp.request().postDataJSON() as any)?.variables ?? {};
      } catch {}
      if (filter && !filter(variables)) return;
      const status = resp.status();
      if (status === 429) {
        rateLimited.push(Date.now());
        log(op, '429 rate limited');
        notify?.();
        return;
      }
      let json: any = null;
      try {
        json = await resp.json();
      } catch {
        return;
      }
      log(op, 'captured', status);
      results.push({ op, variables, status, json });
      notify?.();
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
  };
  page.on('response', handler);

  return {
    results,
    rateLimited,
    /** Resolve true once results.length > count (or a 429 arrives), false on timeout. */
    async waitFor(count: number, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      const startRl = rateLimited.length;
      while (results.length <= count && rateLimited.length === startRl) {
        const left = deadline - Date.now();
        if (left <= 0) return false;
        await new Promise<void>(r => {
          const t = setTimeout(r, Math.min(left, 250));
          notify = () => {
            clearTimeout(t);
            r();
          };
        });
        notify = null;
      }
      return results.length > count;
    },
    async stop() {
      page.off('response', handler);
      await Promise.all([...pending]);
    },
  };
}
