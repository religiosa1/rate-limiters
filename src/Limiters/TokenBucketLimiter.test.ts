import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { TokenBucketLimiter, TokenBucketLimiterNoLua } from "./TokenBucketLimiter";

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
		const tbl = new Limiter(client, { limit: 3 });
		for (let i = 0; i < tbl.opts.limit; i++) {
			const isLimited = await tbl.applyLimit(clientId);
			expect(isLimited).toBe(false);
		}
		const isLimited = await tbl.applyLimit(clientId);
		expect(isLimited).toBe(true);
	});

	// TODO test refill on actual token consumption

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
					await tbl.applyLimit(clientId);
				}
				// After depletion must be 0
				const n1 = await tbl.calculateRefilledTokenAmount(clientId);
				expect(n1).toBeCloseTo(0.0);

				// Half of refill rate -- half of token is there.
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs / 2);
				const n2 = await tbl.calculateRefilledTokenAmount(clientId);
				expect(n2).toBeCloseTo(0.5);

				// The rest of the time for full refill, must be up to the limit
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 2.5);
				const n3 = await tbl.calculateRefilledTokenAmount(clientId);
				expect(n3).toBeCloseTo(3);

				// TSome additional time passed, it won't go above maximum
				vi.advanceTimersByTime(tbl.opts.refillIntervalMs * 2.5);
				const n4 = await tbl.calculateRefilledTokenAmount(clientId);
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
