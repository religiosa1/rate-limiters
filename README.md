# Simple implementation of rate limiting strategies

Inspired by [this article](https://smudge.ai/blog/ratelimit-algorithms), 
describing various strategies of  implementing a rate-limtier for a web-service, 
I decided to create some simple implementation in node js.

This app, is a web-service, which provides endpoints with different 
rate-limiting strategies.

```http
GET localhost:8000
X-Client-Id: some-client-id
```

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