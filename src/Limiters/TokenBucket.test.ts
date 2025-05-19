import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { StartedValkeyContainer, ValkeyContainer } from "@testcontainers/valkey";
import { GlideClient } from "@valkey/valkey-glide";
import { TokenBucketLimiter } from "./TokenBucket";

describe("TokenBucket", () => {
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
		const name = crypto.randomUUID();
		const tbl = new TokenBucketLimiter(client, { limit: 3 });
		for (let i = 0; i < tbl.opts.limit; i++) {
			const isLimited = await tbl.applyLimit(name);
			expect(isLimited).toBe(false);
		}
		const isLimited = await tbl.applyLimit(name);
		expect(isLimited).toBe(true);
	});

	// TODO test refill

	it("allows to get the refill amount in ms tokens", async () => {
		const tbl = new TokenBucketLimiter(client, {
			refillInterval: 1000,
			refillRate: 2,
		});

		expect(tbl.getRefillAmountInMs(1000)).toBe(2);
		expect(tbl.getRefillAmountInMs(1500)).toBe(3);
		expect(tbl.getRefillAmountInMs(2000)).toBe(4);
	});

	it("allows to get time for a complete refill", async () => {
		expect(
			new TokenBucketLimiter(client, {
				limit: 4,
				refillInterval: 1000,
				refillRate: 2,
			}).timeForCompleteRefillMs
		).toBe(2000);
		expect(
			new TokenBucketLimiter(client, {
				limit: 6,
				refillInterval: 3000,
				refillRate: 1,
			}).timeForCompleteRefillMs
		).toBe(18_000);
		expect(
			new TokenBucketLimiter(client, {
				limit: 10,
				refillInterval: 1000,
				refillRate: 10,
			}).timeForCompleteRefillMs
		).toBe(1000);
	});
});
