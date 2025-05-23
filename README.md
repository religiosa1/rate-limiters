# NodeJS/Typescript implementation of various rate limiter strategies

Inspired by [this article](https://smudge.ai/blog/ratelimit-algorithms),
describing various strategies of rate-limtier for a web-service,
I decided to create some Typescript implementation in node js, using
[valkey](https://valkey.io/) storage with [GLIDE](https://valkey.io/valkey-glide/)
client.

Available limiter types:

- [Fixed Window](./src//Limiters/FixedWindowLimiter.ts) splits time in fixed
  chunks -- windows -- and tracks the number of hits per chunk. Dead
  simple: requires only one counter per client. However, it allows bursts of
  hits at the boundary between two windows. Refills all at once when the
  window ends.
- [Sliding Window](./src/Limiters/SlidingWindowLimiter.ts) tracks the timestamp
  of every hit for the window duration. If a client hits the limit, their
  allowance refills one-by-one as hits age out of the window. This is the
  most accurate method but also the most resource- and memory-intensive.
- [Floating Window](./src/Limiters/FloatingWindowLimiter.ts) aka Approximated
  Sliding Window. Splits time into fixed chunks and keeps counters for both the
  current and previous chunks, but estimates the amount of hits for a
  virtual sliding window as follows:

  $`prevWindowCount * prevWindowRate + currentWindowCount`$

  where $prevWindowRate$ is the proportion of the previous window that overlaps
  with the sliding duration.
  It uses math to closely approximate a sliding window with just two counters
  per client, but it’s not 100% accurate. Allowance refils one-by-one.

- [Token Bucket](./src/Limiters/TokenBucketLimiter.ts) maintains a count of
  available hits and the timestamp of the last hit per client. Instead
  of using fixed windows, it applies a refill rate, allowing tokens (hits)
  to replenish over time. Replenishment is calculated when new hits arrive.
  Think mana in computer games. More complex, but it only needs a counter
  and a timestamp per client in Valkey

Each limiter is implemented as a class, conforming to the
[IRateLimiter](./src//Limiters//IRateLimiter.ts) interface. Each limiter is
provided in two versions: one where `registerHit` method is executed only in
TS (involving multiple calls to the Valkey instance, either separately or in a
single transaction), and one where `registerHit` is executed as a Lua script
directly on the Valkey instance.

- The former version always has a `NoLua` suffix in its name. It is susceptible
  to race conditions during simultaneous hits from the same client, which
  may result in false negatives. It serves primarily as a simpler or
  fallback implementation -- for cases where Lua cannot be used or when
  simplicity is preferred over robustness. This version also **cannot** be used
  with Valkey in cluster mode.
- The latter version, without the NoLua suffix, is the more robust
  implementation. It is safe against race conditions and is compatible with
  Valkey cluster mode. This is the **recommended** and main implementation.

The app itself, is a web-service, which provides endpoints with different
rate-limiting strategies.

```http
GET localhost:8000/:limiterName
X-Client-Id: some-client-id
```

Where `:limiterName` name matches available limiter type in kebab-case:

- `fixed-window`
- `sliding-window`
- `floating-window`
- `token-bucket`

## Running the project

Each middleware uses [valkey] instance for storing hits.
So you need a valkey available to start the project. You can install it on
your machine, use some remote instance, or launch one in the docker:

```sh
docker run --name rate-limiter-valkey -d valkey/valkey
```

By default server tries to connect to `localhost:6379`, use `VALKEY_HOST` and
`VALKEY_PORT` env variables to override those values.

Installing dependncies and launching the project in dev mode:

```sh
npm install
npm run dev
```

Then try hitting the endpoint a couple of times with a http client of your
liking, using curl as an example:

```
curl http://localhost:8000/fixed-window -H 'x-client-id: 1'
```

## Running unit-tests

Unit tests are written using [vitest](https://vitest.dev/) and
[Testcontainers](https://testcontainers.com/) to run against a Valkey container
without mocks. It requires a rootless Docker daemon running on your PC, as well
as nodejs22+

To run the tests:

```sh
npm run test
```

## License

Whatever this is, it's MIT-licensed, you can use it freely, with no restrictions
or warranties.
