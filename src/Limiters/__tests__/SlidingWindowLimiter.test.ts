import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { SlidingWindowLimiter, SlidingWindowLimiterNoLua } from "../SlidingWindowLimiter";

describe.each([
	["No lua", SlidingWindowLimiterNoLua],
	["Lua", SlidingWindowLimiter],
])("%s: SlidingWindowLimiter", (_, Limiter) => {
	let container: StartedValkeyContainer;
	let client: GlideClient;

	beforeAll(async () => {
		container = await new ValkeyContainer("valkey/valkey:8.0").start();
		client = await GlideClient.createClient({
			addresses: [{ host: container.getHost(), port: container.getPort() }],
		});
		vi.useFakeTimers();
		// Setting everything to zero, so we're at the start of the quant.
		// Must be in the future, so valkey won't immediately delete our keys.
		vi.setSystemTime("2200-01-01T00:00:00.000");
	});

	afterAll(async () => {
		vi.useRealTimers();
		client.close();
		await container.stop();
	});

	it("limits the hit, if it exceeds the allowance", async () => {
		const clientId = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });

		expect(await swl.registerHit(clientId)).toBe(2);
		vi.advanceTimersByTime(50);
		expect(await swl.registerHit(clientId)).toBe(1);
		vi.advanceTimersByTime(50);
		expect(await swl.registerHit(clientId)).toBe(0);
		vi.advanceTimersByTime(50);
	});

	it("treats hits from separate clients separately", async () => {
		const clientId1 = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });

		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.registerHit(clientId1);
			expect(result).toBe(swl.opts.limit - i - 1);
			vi.advanceTimersByTime(50);
		}

		const clientId2 = crypto.randomUUID();
		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.registerHit(clientId2);
			expect(result).toBe(swl.opts.limit - i - 1);
			vi.advanceTimersByTime(50);
		}
	});

	it("refills the allowance one by one, after the windowSizeMs time since the last hit", async () => {
		const clientId = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });
		const timeStep = 50;

		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.registerHit(clientId);
			expect(result).toBe(swl.opts.limit - i - 1);
			vi.advanceTimersByTime(timeStep);
		}
		// after duration - spentTime ms first hit must be available
		vi.advanceTimersByTime(swl.opts.windowSizeMs - timeStep * swl.opts.limit);
		const r1 = await swl.registerHit(clientId);
		expect(r1).toBe(0);
		// next hit will be available after the previous hit also expires
		vi.advanceTimersByTime(timeStep);
		const r3 = await swl.registerHit(clientId);
		expect(r3).toBe(0);
		// but only 1 hit shoul be available
		const r2 = await swl.registerHit(clientId);
		expect(r2).toBe(-1);
	});

	it("allows to get the current available hits amount", async () => {
		const clientId = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });
		const timeStep = 50;

		for (let i = 0; i < swl.opts.limit; i++) {
			const currentLimit = await swl.getAvailableHits(clientId);
			expect(currentLimit).toBe(swl.opts.limit - i);
			const result = await swl.registerHit(clientId);
			expect(result).toBe(swl.opts.limit - i - 1);
			vi.advanceTimersByTime(timeStep);
		}
	});
});
