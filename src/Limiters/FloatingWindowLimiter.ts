import z from "zod";
import { dedent as d } from "ts-dedent";
import { Script, Transaction, type GlideClient } from "@valkey/valkey-glide";
import type { IRateLimiter } from "./IRateLimiter";

const floatingWindowLimiterOptsSchema = z.object({
	/** Fixed Window size in ms */
	windowSizeMs: z.number().int().positive(),
	/** First window start, e.g. start of the day */
	startDate: z.date(),
	/** Maximum amount of hits in the window */
	limit: z.number().int().positive(),
	/** Valkey keys prefix */
	keyPrefix: z.string(),
});
type FloatingWindowLimiterOpts = z.infer<typeof floatingWindowLimiterOptsSchema>;

/** Floating Window Limiter, aka Approximate Window Limiter -- transaction version.
 *
 *  Stores 2 counters for two fixed windows -- current andd previous and
 * calculates the approximation of a sliding window as
 * prevWindowCount * prevWindowWeight + currentWindowCount
 *
 * This version of class performs all of the operations in a single valkey
 * transaction an thus should be robust enough against race conditions, but
 * still lua version might be preferrable for performance reasons.
 */
export class FloatingWindowLimiterNoLua implements IRateLimiter {
	static readonly defaultOpts: FloatingWindowLimiterOpts = {
		windowSizeMs: 60_000,
		limit: 1,
		startDate: new Date(0),
		keyPrefix: "floating_window_limiter",
	};

	public readonly opts: FloatingWindowLimiterOpts;

	constructor(protected valkey: GlideClient, opts?: Partial<FloatingWindowLimiterOpts>) {
		if (opts != null) {
			floatingWindowLimiterOptsSchema.partial().parse(opts);
		}
		this.opts = { ...FloatingWindowLimiterNoLua.defaultOpts, ...opts };
	}

	async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const currentWindowStart = this.calcFixedWindowStartTs(nowTs);

		const prevKey = this.getClientWindowKey(clientId, currentWindowStart - this.opts.windowSizeMs);
		const curKey = this.getClientWindowKey(clientId, currentWindowStart);

		const tx = new Transaction()
			.get(prevKey) //
			.incr(curKey)
			.pexpireAt(curKey, currentWindowStart + this.opts.windowSizeMs);

		let [prevCount, curCount] = (await this.valkey.exec(tx)) ?? [];

		// If there were no hits -- setting as zeros
		prevCount = prevCount == null ? 0 : Number(prevCount);
		curCount = curCount == null ? 0 : Number(curCount);

		const weight = this.calcPrevWindowWeight(nowTs);
		const approx = prevCount * weight + curCount;

		return Math.floor(this.opts.limit - approx);
	}

	async getAvailableHits(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const currentWindowStart = this.calcFixedWindowStartTs(nowTs);

		const prevKey = this.getClientWindowKey(clientId, currentWindowStart - this.opts.windowSizeMs);
		const curKey = this.getClientWindowKey(clientId, currentWindowStart);

		const tx = new Transaction()
			.get(prevKey) //
			.get(curKey);
		let [prevCount, curCount] = (await this.valkey.exec(tx)) ?? [];
		// If there were no hits -- setting as zeros
		prevCount = prevCount == null ? 0 : Number(prevCount);
		curCount = curCount == null ? 0 : Number(curCount);
		const weight = this.calcPrevWindowWeight(nowTs);
		const approx = prevCount * weight + curCount;
		return this.opts.limit - approx;
	}

	protected calcPrevWindowWeight(nowTs: number): number {
		const currentWindowStart = this.calcFixedWindowStartTs(nowTs);
		const slidingWindowStart = nowTs - this.opts.windowSizeMs;
		const prevWindowDiff = currentWindowStart - slidingWindowStart;
		return prevWindowDiff / this.opts.windowSizeMs;
	}

	protected getClientWindowKey(clientId: string, winowStartTs: number): string {
		return `${this.opts.keyPrefix}:${winowStartTs}:${clientId}`;
	}

	protected calcFixedWindowStartTs(nowTs: number): number {
		const start = this.opts.startDate.getTime();
		const duration = this.opts.windowSizeMs;
		return Math.floor((nowTs - start) / duration) * duration + start;
	}
}

/** Floating Window Limiter, aka Approximate Window Limiter -- lua on valkey version.
 *
 *  Stores 2 counters for two fixed windows -- current andd previous and
 * calculates the approximation of a sliding window as
 * prevWindowCount * prevWindowWeight + currentWindowCount
 *
 * This version of class executes registerHit operations as a lua script on the
 * valkey instance, to avoid potential race conditions.
 */
export class FloatingWindowLimiter extends FloatingWindowLimiterNoLua {
	private static readonly luaScript = new Script(d`
		local key_prev = KEYS[1]
		local key_current = KEYS[2]
		
		local expire_at_ms = tonumber(ARGV[1])
		local prev_window_weight = tonumber(ARGV[2])
		local limit = tonumber(ARGV[3])


		local count_prev = tonumber(redis.call('GET', key_prev))
		if count_prev == nil then
			count_prev = 0
		end
		local count_current = tonumber(redis.call('INCR', key_current))
		if count_current == 1 then
			-- This is the first hit in the window, set expiration
			redis.call('PEXPIREAT', key_current, expire_at_ms)
		end

		local approx = count_prev * prev_window_weight + count_current

		return limit - approx`);

	override async registerHit(clientId: string): Promise<number> {
		const nowTs = Date.now();
		const currentWindowStart = this.calcFixedWindowStartTs(nowTs);
		const curKey = this.getClientWindowKey(clientId, currentWindowStart);
		const prevKey = this.getClientWindowKey(clientId, currentWindowStart - this.opts.windowSizeMs);
		const expireAtMs = currentWindowStart + this.opts.windowSizeMs;
		const limit = this.opts.limit;
		const weight = this.calcPrevWindowWeight(nowTs);

		const result = await this.valkey.invokeScript(FloatingWindowLimiter.luaScript, {
			keys: [prevKey, curKey],
			args: [expireAtMs, weight, limit].map(String),
		});
		if (typeof result !== "number") {
			throw TypeError(`Unexpected script execution result type: ${typeof result}`);
		}

		return Math.floor(result);
	}
}
