import z from "zod";
import d from "ts-dedent";
import { Script, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const fixedWindowLimiterOptsSchema = z.object({
	/** Fixed Window size in ms */
	duration: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of requests in the window */
	limit: z.number().int().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});
type FixedWindowLimiterOpts = z.infer<typeof fixedWindowLimiterOptsSchema>;

/** Fixed window limiter -- in memory version.
 *
 * Stores the amount of requests per window in a single key, which contains
 * window start timestamp and expires, when the window expires. applyLimit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the request will be considered limited.
 *
 * This version of class executes all operations in memory, performing multiple
 * requests to valkey in applyLimit method andd thus is susceptible to race
 * conditions during simultaneous requests from the same client which results in
 * false negatives. Use the version of the class without NoLua suffix to address
 * the issue.
 */
export class FixedWindowLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: FixedWindowLimiterOpts = {
		duration: 60_000,
		limit: 1,
		startDate: new Date(0),
		keyPrefix: "fixed_window_limiter:",
	};

	public readonly opts: FixedWindowLimiterOpts;

	constructor(protected readonly valkey: GlideClient, opts?: Partial<FixedWindowLimiterOpts>) {
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
		return str ? +str : null;
	}

	protected getClientKey(clientId: string): string {
		const startTs = this.getCurrentWindowStartTs();
		return `${this.opts.keyPrefix}:${startTs}:${clientId}`;
	}

	protected getCurrentWindowStopTs(): number {
		return this.getCurrentWindowStartTs() + this.opts.duration;
	}

	private getCurrentWindowStartTs(): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.duration;
		return Math.floor((Date.now() - start) / duration) * duration + start;
	}

	private async trackRequest(clientId: string): Promise<void> {
		const key = this.getClientKey(clientId);
		const expireAt = this.getCurrentWindowStopTs() / 1000;
		const tx = new Transaction()
			.incr(key) //
			.expireAt(key, expireAt);
		await this.valkey.exec(tx);
	}
}

/** Fixed window limiter.
 *
 * Stores the amount of requests per window in a single key, which contains
 * window start timestamp and expires, when the window expires. applyLimit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the request will be considered limited.
 *
 * This version of class executes applyLimit operations as a lua script on the
 * valkey instance, to avoid potential race conditions.
 */
export class FixedWindowLimiter extends FixedWindowLimiterNoLua {
	private static readonly luaScript = new Script(d`
		local key = KEYS[1]
		local limit = tonumber(ARGV[1])
		local expire_at_seconds = tonumber(ARGV[2])

		local current_count = redis.call('INCR', key)

		if current_count == 1 then
			${"" /* This is the first request in the window, set expiration */}
			redis.call('EXPIREAT', key, expire_at_seconds)
		end

		if current_count > limit then
			return 1 ${"" /* Rate limited */}
		else
			return 0 ${"" /* Allowed */}
		end`);

	/** Applies limiting to a client's id.
	 * @param clientId client unique id
	 * @returns true if request should be limited, false otherwise
	 */
	async applyLimit(clientId: string): Promise<boolean> {
		const key = this.getClientKey(clientId);
		const expireAtSeconds = Math.floor(this.getCurrentWindowStopTs() / 1000);

		const result = await this.valkey.invokeScript(FixedWindowLimiter.luaScript, {
			keys: [key],
			args: [this.opts.limit.toString(), expireAtSeconds.toString()],
		});

		// Valkey EVAL returns 0 for false, 1 for true from Lua script
		return !!result;
	}
}
