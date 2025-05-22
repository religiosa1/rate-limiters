import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { FixedWindowLimiter, FixedWindowLimiterNoLua } from "./FixedWindowLimiter";
import { Time } from "./consts";

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
			limit: 5,
			windowSizeMs: 3 * Time.Minute,
		});

		// Ar first hits are not limited
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.applyLimit(clientId);
			expect(result).toBe(false);
		}
		// Now we reach the limit and must be limited
		expect(await fwl.applyLimit(clientId)).toBe(true);
	});

	it("treats hits from separate clients separately", async () => {
		const clientId1 = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });

		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.applyLimit(clientId1);
			expect(result).toBe(false);
		}

		const clientId2 = crypto.randomUUID();
		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.applyLimit(clientId2);
			expect(result).toBe(false);
		}
	});

	it("drops limits after predefined amount of time has passed", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 5,
			windowSizeMs: 3 * Time.Minute,
		});

		// Exhausting the limit
		for (let i = 0; i < fwl.opts.limit; i++) {
			await fwl.applyLimit(clientId);
		}
		// After duration amount of time has passed, we're not limited again
		vi.advanceTimersByTime(fwl.opts.windowSizeMs * Time.Minute);
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.applyLimit(clientId);
			expect(result).toBe(false);
		}
		// and then we are limited again
		expect(await fwl.applyLimit(clientId)).toBe(true);
	});

	it("partially exhausted limits in the previous quant have no impact on current limits", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 5,
			windowSizeMs: 3 * Time.Minute,
		});

		// Exhausting half of the limit
		for (let i = 0; i < fwl.opts.limit / 2; i++) {
			await fwl.applyLimit(clientId);
		}
		// Waiting for the next quant -- next minutes
		vi.advanceTimersByTime(fwl.opts.windowSizeMs * Time.Minute);
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.applyLimit(clientId);
			expect(result).toBe(false);
		}
		// and then we are limited again
		expect(await fwl.applyLimit(clientId)).toBe(true);
	});

	it("allows to get the current available hits amount", async () => {
		const clientId = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });
		const timeStep = 50;

		for (let i = 0; i < swl.opts.limit; i++) {
			const currentLimit = await swl.getAvailableHits(clientId);
			expect(currentLimit).toBe(swl.opts.limit - i);
			const result = await swl.applyLimit(clientId);
			expect(result).toBe(false);
			vi.advanceTimersByTime(timeStep);
		}
	});
});
