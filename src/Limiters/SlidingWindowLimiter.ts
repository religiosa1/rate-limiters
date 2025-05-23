import z from "zod";
import { dedent as d } from "ts-dedent";
import { InfBoundary, Script, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const slidingWindowLimiterOptsSchema = z.object({
	/** Sliding Window size in ms */
	windowSizeMs: z.number().int().positive(),
	/** Maximum amount of hits in the window */
	limit: z.number().int().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});
type SlidingWindowLimiterOpts = z.infer<typeof slidingWindowLimiterOptsSchema>;

/** Sliding window limiter -- transaction version.
 *
 * Stores multiple hits in ZSET in valkey and refills one hit at the
 * time.
 *
 * This version of class performs all of the operations in a single valkey
 * transaction an thus should be robust enough against race conditions, but
 * still lua version might be preferrable for performance reasons.
 */
export class SlidingWindowLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: SlidingWindowLimiterOpts = {
		windowSizeMs: 60_000,
		limit: 20,
		keyPrefix: "sliding_window_limiter",
	};

	public readonly opts: SlidingWindowLimiterOpts;

	constructor(protected readonly valkey: GlideClient, opts?: Partial<SlidingWindowLimiterOpts>) {
		if (opts != null) {
			slidingWindowLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...SlidingWindowLimiterNoLua.defaultOpts, ...opts };
	}

	async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const windowStartTs = nowTs - this.opts.windowSizeMs;
		const key = this.getClientKey(clientId);
		await this.removeExpiredHits(clientId, nowTs);
		const tx = new Transaction()
			.zremRangeByScore(key, InfBoundary.NegativeInfinity, { value: windowStartTs, isInclusive: true })
			.zadd(key, [
				{
					element: crypto.randomUUID(),
					score: nowTs,
				},
			])
			.pexpireAt(key, nowTs + this.opts.windowSizeMs)
			.zcount(key, { value: windowStartTs }, { value: nowTs });
		let [, , , count] = (await this.valkey.exec(tx)) ?? [];
		count = count == null ? 0 : Number(count);

		return this.opts.limit - count;
	}

	async getAvailableHits(clientId: string): Promise<number> {
		return await this.getAvailableHitsAtTime(clientId, Date.now());
	}

	private async getAvailableHitsAtTime(clientId: string, nowTs: number): Promise<number> {
		const key = this.getClientKey(clientId);
		const windowStartTs = nowTs - this.opts.windowSizeMs;
		const count = await this.valkey.zcount(key, { value: windowStartTs }, { value: nowTs });
		return Math.max(this.opts.limit - count, 0);
	}

	protected getClientKey(clientId: string): string {
		return `${this.opts.keyPrefix}:${clientId}`;
	}

	private async removeExpiredHits(clientId: string, nowTs: number): Promise<void> {
		const key = this.getClientKey(clientId);
		const windowStartTs = nowTs - this.opts.windowSizeMs;
		await this.valkey.zremRangeByScore(key, InfBoundary.NegativeInfinity, { value: windowStartTs, isInclusive: true });
	}
}

/** Sliding window limiter -- lua on valkey version.
 *
 * Stores multiple hits in ZSET in valkey and refills one hit at the
 * time.
 *
 * This version of class executes registerHit operations as a lua script on the
 * valkey instance, to avoid potential race conditions.
 */
export class SlidingWindowLimiter extends SlidingWindowLimiterNoLua {
	private static readonly luaScript = new Script(d`
		local key = KEYS[1]
		local hit_id = ARGV[1]
		local now_ts = tonumber(ARGV[2])
		local window_size = tonumber(ARGV[3])
		local limit = tonumber(ARGV[4])

		local window_start_ts = now_ts - window_size

		-- Removing expired values from set first
		redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start_ts)
		-- Adding current hit to the set
		redis.call('ZADD', key, now_ts, hit_id)
		-- Setting expiration on the whole key
		redis.call('PEXPIREAT', key, now_ts + window_size)

		local count = redis.call('ZCOUNT', key, window_start_ts, now_ts)

		return limit - count`);

	override async registerHit(clientId: string): Promise<number> {
		const key = this.getClientKey(clientId);
		const hitId = crypto.randomUUID();
		const nowTs = Date.now();
		const windowSize = this.opts.windowSizeMs;
		const limit = this.opts.limit;

		const result = await this.valkey.invokeScript(SlidingWindowLimiter.luaScript, {
			keys: [key],
			args: [hitId, nowTs, windowSize, limit].map(String),
		});
		if (typeof result !== "number") {
			throw TypeError(`Unexpected script execution result type: ${typeof result}`);
		}
		return result;
	}
}
