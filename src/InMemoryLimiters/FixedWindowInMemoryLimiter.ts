import {
	inMemoryRateLimiterOptsDefaults,
	inMemoryRateLimiterOptsSchema,
	type IInMemoryRateLimiter,
	type InMemoryRateLimiterOpts,
} from "./IInMemoryRateLimiter";
import { RateLimiterWindow } from "./LimiterWindow";

/** Fixed window limiter -- In-Memory version.
 *
 * Stores the amount of hits per window in a single key, which contains
 * window start timestamp and expires, when the window expires. registerHit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the hit will be considered limited.
 *
 * Notice that in-memory version isn't thread safe and can't be used in cluster
 * mode. It will also lose all stored hitd info.
 */
export class FixedWindowInMemoryLimiter implements IInMemoryRateLimiter {
	readonly opts: InMemoryRateLimiterOpts;

	private window: RateLimiterWindow;

	constructor(opts?: Partial<InMemoryRateLimiterOpts> | undefined) {
		if (opts != null) {
			inMemoryRateLimiterOptsSchema.partial().parse(opts);
		}

		this.opts = { ...inMemoryRateLimiterOptsDefaults, ...opts };
		this.window = new RateLimiterWindow(this.calcWindowStartTs(), this.opts.windowSizeMs);
	}

	registerHit(clientId: string): number {
		const ts = Date.now();
		this.checkWindowExpiration(ts);

		const nHits = (this.window.clientHitCounter.get(clientId) ?? 0) + 1;
		this.window.clientHitCounter.set(clientId, nHits);

		return this.opts.limit - nHits;
	}

	getAvailableHits(clientId: string): number {
		const ts = Date.now();
		this.checkWindowExpiration(ts);

		const nHits = this.window.clientHitCounter.get(clientId) ?? 0;

		return this.opts.limit - nHits;
	}

	checkExpiration(): void {
		this.checkWindowExpiration(Date.now());
	}

	clear(): void {
		this.window = new RateLimiterWindow(this.calcWindowStartTs(), this.opts.windowSizeMs);
	}

	private calcWindowStartTs(ts = Date.now()): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.windowSizeMs;
		return Math.floor((ts - start) / duration) * duration + start;
	}

	private checkWindowExpiration(ts: number): void {
		if (this.window.isExpiredAt(ts)) {
			this.window = new RateLimiterWindow(this.calcWindowStartTs(ts), this.opts.windowSizeMs);
		}
	}
}
