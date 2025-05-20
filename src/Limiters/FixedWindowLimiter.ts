import z from "zod";
import { Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const fixedWindowLimiterOptsSchema = z.object({
	/** Fixed Window size in ms */
	duration: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of requests in the window */
	limit: z.number().int().positive(),
});
type FixedWindowLimiterOpts = z.infer<typeof fixedWindowLimiterOptsSchema>;

/** Fixed window limiter.
 *
 * Stores the amount of requests per window in a single key, which contains
 * window start timestamp and expires, when the window expires. applyLimit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the request will be considered limited.
 */
export class FixedWindowLimiter implements IRateLimiter {
	static readonly defaultOpts: FixedWindowLimiterOpts = {
		duration: 1,
		limit: 60_000,
		get startDate() {
			return new Date();
		},
	};

	public readonly opts: FixedWindowLimiterOpts;

	constructor(private readonly valkey: GlideClient, opts?: Partial<FixedWindowLimiterOpts>) {
		if (opts != null) {
			fixedWindowLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...FixedWindowLimiter.defaultOpts, ...opts };
	}

	/** Applies limiting to a client's id.
	 * @param clientId client unique id
	 * @returns true if request should be limited, false otherwise
	 */
	async applyLimit(clientId: string): Promise<boolean> {
		const nRequests = await this.getCurrentRequestAmount(clientId);
		if (nRequests && nRequests >= this.opts.limit) {
			return true;
		}

		await this.trackRequest(clientId);
		return false;
	}

	/** Get the amount of requests performed during the current window (<= limit) */
	async getCurrentRequestAmount(clientId: string): Promise<number | null> {
		const key = this.getClientKey(clientId);
		const str = await this.valkey.get(key);
		return str != null ? +str : null;
	}

	private async trackRequest(clientId: string): Promise<void> {
		const key = this.getClientKey(clientId);
		const expireAt = this.getCurrentWindowStopTs() / 1000;
		const tx = new Transaction()
			.incr(key) //
			.expireAt(key, expireAt);
		await this.valkey.exec(tx);
	}

	private getClientKey(clientId: string): string {
		const startTs = this.getCurrentWindowStartTs();
		return `fixedwindow:${startTs}:${clientId}`;
	}

	private getCurrentWindowStartTs(): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.duration;
		return Math.floor((Date.now() - start) / duration) * duration + start;
	}

	private getCurrentWindowStopTs(): number {
		return this.getCurrentWindowStartTs() + this.opts.duration;
	}
}
