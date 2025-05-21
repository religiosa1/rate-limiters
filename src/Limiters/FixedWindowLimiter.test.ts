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

	it("limits the requests to the amount in fixed period", async () => {
		const clientId = crypto.randomUUID();
		const fwl = new Limiter(client, {
			limit: 5,
			windowSizeMs: 3 * Time.Minute,
		});

		// First requests are not limited
		for (let i = 0; i < fwl.opts.limit; i++) {
			const result = await fwl.applyLimit(clientId);
			expect(result).toBe(false);
		}
		// Now we reach the limit and must be limited
		expect(await fwl.applyLimit(clientId)).toBe(true);
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
});
