# Simple implementation of rate limiting strategies

Inspired by [this article](https://smudge.ai/blog/ratelimit-algorithms),
describing various strategies of implementing a rate-limtier for a web-service,
I decided to create some simple implementation in node js, using
[valkey](https://valkey.io/) storage via [GLIDE](https://valkey.io/valkey-glide/)
client.

Available limiter types:

- [Fixed Window](./src//Limiters/FixedWindowLimiter.ts)
- [Sliding Window](./src/Limiters/SlidingWindowLimiter.ts)
- Floating Window aka Approximated Sliding Window TODO
- [Token Bucket](./src/Limiters/TokenBucketLimiter.ts)

The app itself, is a web-service, which provides endpoints with different
rate-limiting strategies.

```http
GET localhost:8000
X-Client-Id: some-client-id
```

Each limiter is written as a class, implementing
[IRateLimiter](./src//Limiters//IRateLimiter.ts) interface. Each limiter
is supplied in two versions -- one performing applyOperation in JS with multiple
separate calls to valkey instance, and one executing applyOperation as a Lua
script on the valkey instance.

- The former always have `NoLua` suffix in its name is susceptible to
  race conditions during simultaneous requests from the same client which
  results in false negatives. It's a secondary, supportive version here mostly
  as a pure exercise, if you want to keep logic rather simpler than robust or
  if you can't execute Lua on your valkey instance for whatever reason.
- The later not having not having `NoLua` suffix is more robust version, as it's
  safe against race conditions. This is the main impelemntation.

## Running the project

Each middleware uses [valkey] instance for storing request hits.
So you need a valkey instance to start the project. You can install it on
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
curl http://localhost:8000/ -H 'x-client-id: 1'
```
