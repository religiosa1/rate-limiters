import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { FloatingWindowLimiter, FloatingWindowLimiterNoLua } from "./FloatingWindowLimiter";

describe.each([
	["No lua", FloatingWindowLimiterNoLua],
	["Lua", FloatingWindowLimiter],
])("%s: FloatingWindowLimiter", (_, Limiter) => {
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

	it("limits the amount of request in a window to the predefined amount", async () => {
		const clientId = crypto.randomUUID();
		const swl = new Limiter(client, { limit: 3, windowSizeMs: 10_000 });

		// Allows the amount of requests as described in opts.limit
		for (let i = 0; i < swl.opts.limit; i++) {
			const result = await swl.applyLimit(clientId);
			expect(result).toBe(false);
			vi.advanceTimersByTime(50);
		}
		// The next request is limited.
		const result = await swl.applyLimit(clientId);
		expect(result).toBe(true);
	});

	// TODO rest of the tests
});
