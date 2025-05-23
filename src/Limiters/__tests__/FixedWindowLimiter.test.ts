import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { FixedWindowLimiter, FixedWindowLimiterNoLua } from "../FixedWindowLimiter";

/**  Ms in minute*/
const Minute = 60 * 1000;

describe.each([
	["No lua", FixedWindowLimiterNoLua],
	["Lua", FixedWindowLimiter],
])("%s: FixedWindowLimiter", (_, Limiter) => {
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

	it("limits the hits to the amount in fixed period", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 3,
			windowSizeMs: 3 * Minute,
		});

		// Ar first hits are not limited
		expect(await fwl.registerHit(clientId)).toBe(2);
		expect(await fwl.registerHit(clientId)).toBe(1);
		expect(await fwl.registerHit(clientId)).toBe(0);
		// Now we reach the limit and must be limited
		expect(await fwl.registerHit(clientId)).toBe(-1);
	});

	it("treats hits from separate clients separately", async () => {
		const clientId1 = crypto.randomUUID();
		const fwl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });

		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.registerHit(clientId1);
			expect(result).toBe(fwl.opts.limit - i - 1);
		}

		const clientId2 = crypto.randomUUID();
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.registerHit(clientId2);
			expect(result).toBe(fwl.opts.limit - i - 1);
		}
	});

	it("drops limits after predefined amount of time has passed", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 5,
			windowSizeMs: 3 * Minute,
		});

		// Exhausting the limit
		for (let i = 0; i < fwl.opts.limit; i++) {
			await fwl.registerHit(clientId);
		}
		// After duration amount of time has passed, we're not limited again
		vi.advanceTimersByTime(fwl.opts.windowSizeMs * Minute);
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.registerHit(clientId);
			expect(result).toBe(fwl.opts.limit - i - 1);
		}
		// and then we are limited again
		expect(await fwl.registerHit(clientId)).toBe(-1);
	});

	it("partially exhausted limits in the previous quant have no impact on current limits", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 5,
			windowSizeMs: 3 * Minute,
		});

		// Exhausting half of the limit
		for (let i = 0; i < fwl.opts.limit / 2; i++) {
			await fwl.registerHit(clientId);
		}
		// Waiting for the next quant -- next minutes
		vi.advanceTimersByTime(fwl.opts.windowSizeMs * Minute);
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.registerHit(clientId);
			expect(result).toBe(fwl.opts.limit - i - 1);
		}
		// and then we are limited again
		expect(await fwl.registerHit(clientId)).toBe(-1);
	});

	it("allows to get the current available hits amount", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });
		const timeStep = 50;

		for (let i = 0; i < fwl.opts.limit; i++) {
			const currentLimit = await fwl.getAvailableHits(clientId);
			expect(currentLimit).toBe(fwl.opts.limit - i);
			const result = await fwl.registerHit(clientId);
			expect(result).toBe(fwl.opts.limit - i - 1);
			vi.advanceTimersByTime(timeStep);
		}
	});
});
