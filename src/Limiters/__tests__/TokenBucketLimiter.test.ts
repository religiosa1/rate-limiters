import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { TokenBucketLimiter, TokenBucketLimiterNoLua } from "../TokenBucketLimiter";

describe.each([
	["No Lua", TokenBucketLimiterNoLua],
	["Lua", TokenBucketLimiter],
])("%s: TokenBucketLimiter", (_, Limiter) => {
	let container: StartedValkeyContainer;
	let client: GlideClient;

	beforeAll(async () => {
		container = await new ValkeyContainer("valkey/valkey:8.0").start();
		client = await GlideClient.createClient({
			addresses: [{ host: container.getHost(), port: container.getPort() }],
		});
	});

	afterAll(async () => {
		client.close();
		await container.stop();
	});

	it("limits rate to predefined value", async () => {
		const clientId = crypto.randomUUID();
		const tbl = new Limiter(client, { limit: 3, refillIntervalMs: 60_000 });
		expect(await tbl.registerHit(clientId)).toBe(2);
		expect(await tbl.registerHit(clientId)).toBe(1);
		expect(await tbl.registerHit(clientId)).toBe(0);
		expect(await tbl.registerHit(clientId)).toBe(-1);
	});

	it("treats hits from separate clients separately", async () => {
		const clientId1 = crypto.randomUUID();
		const tbl = new Limiter(client, { limit: 3, refillIntervalMs: 10_000 });

		for (let i = 0; i < tbl.opts.limit; i++) {
			const result = await tbl.registerHit(clientId1);
			expect(result).toBe(tbl.opts.limit - i - 1);
		}

		const clientId2 = crypto.randomUUID();
		for (let i = 0; i < tbl.opts.limit; i++) {
			const result = await tbl.registerHit(clientId2);
			expect(result).toBe(tbl.opts.limit - i - 1);
		}
	});

	it("refills in the expected time", async () => {
		vi.useFakeTimers();
		try {
			const clientId = crypto.randomUUID();
			const tbl = new Limiter(client, {
				refillIntervalMs: 1000,
				refillRate: 1,
				limit: 3,
			});
			// exchausting the bucket completely
			for (let i = 0; i < tbl.opts.limit; i++) {
				expect(await tbl.registerHit(clientId)).toBe(tbl.opts.limit - i - 1);
			}
			expect(await tbl.registerHit(clientId)).toBe(-1);

			vi.advanceTimersByTime(tbl.opts.refillIntervalMs);
			expect(await tbl.registerHit(clientId)).toBe(0);
			// waiting for 1.5 refill time
			vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 1.5);
			expect(await tbl.registerHit(clientId)).toBe(0);
			// and again -- now we have extra token
			vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 1.5);
			expect(await tbl.registerHit(clientId)).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("allows to get the current available hits amount", async () => {
		vi.useFakeTimers();
		try {
			const clientId = crypto.randomUUID();
			const tbl = new Limiter(client, { limit: 3, refillIntervalMs: 1000 });
			// As we're dealing with floats here, we're using toBeCloseTo
			expect(await tbl.getAvailableHits(clientId)).toBeCloseTo(3);
			expect(await tbl.registerHit(clientId)).toBe(2);

			expect(await tbl.getAvailableHits(clientId)).toBeCloseTo(2);
			expect(await tbl.registerHit(clientId)).toBe(1);

			expect(await tbl.getAvailableHits(clientId)).toBeCloseTo(1);
			expect(await tbl.registerHit(clientId)).toBe(0);

			expect(await tbl.getAvailableHits(clientId)).toBeCloseTo(0);
			expect(await tbl.registerHit(clientId)).toBe(-1);
		} finally {
			vi.useRealTimers();
		}
	});

	describe("helper methods -- js calculation", () => {
		it("calculates the refil rate in the expected time", async () => {
			vi.useFakeTimers();
			try {
				const clientId = crypto.randomUUID();
				const tbl = new Limiter(client, {
					refillIntervalMs: 1000,
					refillRate: 1,
					limit: 3,
				});
				for (let i = 0; i < tbl.opts.limit; i++) {
					await tbl.registerHit(clientId);
				}
				// After depletion must be 0
				const n1 = await tbl.getAvailableHits(clientId);
				expect(n1).toBeCloseTo(0.0);

				// Half of refill rate -- half of token is there.
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs / 2);
				const n2 = await tbl.getAvailableHits(clientId);
				expect(n2).toBeCloseTo(0.5);

				// The rest of the time for full refill, must be up to the limit
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 2.5);
				const n3 = await tbl.getAvailableHits(clientId);
				expect(n3).toBeCloseTo(3);

				// TSome additional time passed, it won't go above maximum
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 2.5);
				const n4 = await tbl.getAvailableHits(clientId);
				expect(n4).toBeCloseTo(3);
			} finally {
				vi.useRealTimers();
			}
		});

		it("allows to get the refill amount in ms tokens", async () => {
			const tbl = new Limiter(client, {
				refillIntervalMs: 1000,
				refillRate: 2,
			});

			expect(tbl.getRefillAmountInMs(1000)).toBe(2);
			expect(tbl.getRefillAmountInMs(1500)).toBe(3);
			expect(tbl.getRefillAmountInMs(2000)).toBe(4);
		});

		it("allows to get time for a complete refill", async () => {
			expect(
				new Limiter(client, {
					limit: 4,
					refillIntervalMs: 1000,
					refillRate: 2,
				}).timeForCompleteRefillMs
			).toBe(2000);
			expect(
				new Limiter(client, {
					limit: 6,
					refillIntervalMs: 3000,
					refillRate: 1,
				}).timeForCompleteRefillMs
			).toBe(18_000);
			expect(
				new Limiter(client, {
					limit: 10,
					refillIntervalMs: 1000,
					refillRate: 10,
				}).timeForCompleteRefillMs
			).toBe(1000);
		});
	});
});
