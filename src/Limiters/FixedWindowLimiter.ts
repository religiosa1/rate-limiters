import z from "zod";
import d from "ts-dedent";
import { Script, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

// TODO: Support for user define start, instead of predefined start date.

const fixedWindowLimiterOptsSchema = z.object({
	/** Fixed Window size in ms */
	windowSizeMs: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of hits in the window */
	limit: z.number().int().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});
type FixedWindowLimiterOpts = z.infer<typeof fixedWindowLimiterOptsSchema>;

/** Fixed window limiter -- transaction version.
 *
 * Stores the amount of hits per window in a single key, which contains
 * window start timestamp and expires, when the window expires. registerHit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the hit will be considered limited.
 *
 * This version of class performs all of the operations in a single valkey
 * transaction an thus should be robust enough against race conditions, but
 * still lua version might be preferrable for performance reasons.
 */
export class FixedWindowLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: FixedWindowLimiterOpts = {
		windowSizeMs: 60_000,
		limit: 20,
		startDate: new Date(0),
		keyPrefix: "fixed_window_limiter",
	};

	public readonly opts: FixedWindowLimiterOpts;

	constructor(protected readonly valkey: GlideClient, opts?: Partial<FixedWindowLimiterOpts>) {
		if (opts != null) {
			fixedWindowLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...FixedWindowLimiterNoLua.defaultOpts, ...opts };
	}

	async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const key = this.getClientKey(clientId, nowTs);
		const expireAtMs = this.calcCurrentWindowStartTs(nowTs) + this.opts.windowSizeMs;
		const tx = new Transaction()
			.incr(key) //
			.pexpireAt(key, expireAtMs);
		let [count] = (await this.valkey.exec(tx)) ?? [];
		count = count == null ? 0 : Number(count);
		return this.opts.limit - count;
	}

	async getAvailableHits(clientId: string): Promise<number> {
		const key = this.getClientKey(clientId, Date.now());
		const str = await this.valkey.get(key);
		if (str == null) {
			return this.opts.limit;
		}
		return this.opts.limit - +str;
	}

	/** Get a timestamp in MS when the current window stops and limits reset.
	 *
	 * Can be used for setting headers like `x-ratelimit-reset`.
	 */
	getCurrentWindowStopTsMs(): number {
		return this.calcCurrentWindowStartTs(Date.now()) + this.opts.windowSizeMs;
	}

	protected getClientKey(clientId: string, nowTs: number): string {
		const startTs = this.calcCurrentWindowStartTs(nowTs);
		return `${this.opts.keyPrefix}:${startTs}:${clientId}`;
	}

	protected calcCurrentWindowStartTs(nowTs: number): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.windowSizeMs;
		return Math.floor((nowTs - start) / duration) * duration + start;
	}
}

/** Fixed window limiter -- lua on valkey version.
 *
 * Stores the amount of hits per window in a single key, which contains
 * window start timestamp and expires, when the window expires. registerHit
 * calls increase the value of this counter, and if it's greater than or equal
 * to the limit option, the hit will be considered limited.
 *
 * This version of class executes registerHit operations as a lua script on the
 * valkey instance, to avoid potential race conditions.
 */
export class FixedWindowLimiter extends FixedWindowLimiterNoLua {
	private static readonly luaScript = new Script(d`
		local key = KEYS[1]
		local limit = tonumber(ARGV[1])
		local expire_at_ms = tonumber(ARGV[2])

		local count = redis.call('INCR', key)

		if count == 1 then
			${"" /* This is the first hit in the window, set expiration */}
			redis.call('PEXPIREAT', key, expire_at_ms)
		end

		return limit - count`);

	override async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const key = this.getClientKey(clientId, nowTs);
		const expireAtMs = this.calcCurrentWindowStartTs(nowTs) + this.opts.windowSizeMs;

		const result = await this.valkey.invokeScript(FixedWindowLimiter.luaScript, {
			keys: [key],
			args: [this.opts.limit.toString(), expireAtMs.toString()],
		});
		if (typeof result !== "number") {
			throw TypeError(`Unexpected script execution result type: ${typeof result}`);
		}
		return Math.max(result, -1);
	}
}
