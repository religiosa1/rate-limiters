import {
	inMemoryRateLimiterOptsDefaults,
	inMemoryRateLimiterOptsSchema,
	type IInMemoryRateLimiter,
	type InMemoryRateLimiterOpts,
} from "./IInMemoryRateLimiter";
import { RateLimiterWindow } from "./LimiterWindow";

/** Floating Window Limiter, aka Approximate Window Limiter -- In-Memory version.
 *
 * Stores in memory 2 counters for two fixed windows -- current andd previous and
 * calculates the approximation of a sliding window as
 * prevWindowCount * prevWindowWeight + currentWindowCount
 *
 * Notice that in-memory version isn't thread safe and can't be used in cluster
 * mode. It will also lose all stored hitd info.
 */
export class FloatingWindowInMemoryLimiter implements IInMemoryRateLimiter {
	readonly opts: InMemoryRateLimiterOpts;

	private currentWindow: RateLimiterWindow;
	private previousWindow: RateLimiterWindow;

	constructor(opts?: Partial<InMemoryRateLimiterOpts> | undefined) {
		if (opts != null) {
			inMemoryRateLimiterOptsSchema.partial().parse(opts);
		}

		this.opts = { ...inMemoryRateLimiterOptsDefaults, ...opts };
		this.currentWindow = new RateLimiterWindow(this.calcWindowStartTs(), this.opts.windowSizeMs);
		this.previousWindow = new RateLimiterWindow(
			this.calcWindowStartTs() - this.opts.windowSizeMs,
			this.opts.windowSizeMs
		);
	}

	registerHit(clientId: string): number {
		const ts = Date.now();
		this.checkWindowExpiration(ts);

		const prevCount = this.previousWindow.clientHitCounter.get(clientId) ?? 0;
		const curCount = (this.currentWindow.clientHitCounter.get(clientId) ?? 0) + 1;

		this.currentWindow.clientHitCounter.set(clientId, curCount);

		const approx = this.calcApproximation(prevCount, curCount, ts);
		return Math.floor(this.opts.limit - approx);
	}

	getAvailableHits(clientId: string): number {
		const ts = Date.now();
		this.checkWindowExpiration(ts);

		const prevCount = this.previousWindow.clientHitCounter.get(clientId) ?? 0;
		const curCount = this.currentWindow.clientHitCounter.get(clientId) ?? 0;

		const approx = this.calcApproximation(prevCount, curCount, ts);
		return Math.floor(this.opts.limit - approx);
	}

	checkExpiration(): void {
		this.checkWindowExpiration(Date.now());
	}

	clear(): void {
		this.currentWindow = new RateLimiterWindow(this.calcWindowStartTs(), this.opts.windowSizeMs);
		this.previousWindow = new RateLimiterWindow(
			this.calcWindowStartTs() - this.opts.windowSizeMs,
			this.opts.windowSizeMs
		);
	}

	private calcWindowStartTs(ts = Date.now()): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.windowSizeMs;
		return Math.floor((ts - start) / duration) * duration + start;
	}

	private checkWindowExpiration(ts: number) {
		if (this.currentWindow.isExpiredAt(ts)) {
			const oldWindowTs = ts - this.previousWindow.duration;
			// Check if we skip more than one window since the last call
			const isCurrentWindowExpiredAsPrevious = this.currentWindow.isExpiredAt(oldWindowTs);
			this.previousWindow = isCurrentWindowExpiredAsPrevious
				? new RateLimiterWindow(this.calcWindowStartTs(oldWindowTs), this.opts.windowSizeMs)
				: this.currentWindow;
			this.currentWindow = new RateLimiterWindow(this.calcWindowStartTs(ts), this.opts.windowSizeMs);
		}
	}

	private calcApproximation(prevCount: number, curCount: number, ts: number): number {
		const currentWindowStart = this.calcWindowStartTs(ts);
		const slidingWindowStart = ts - this.opts.windowSizeMs;
		const prevWindowDiff = currentWindowStart - slidingWindowStart;

		const weight = prevWindowDiff / this.opts.windowSizeMs;
		const approx = prevCount * weight + curCount;

		return approx;
	}
}
