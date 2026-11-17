# Northwind API Reference

## Authentication

All requests must include an `Authorization: Bearer <token>` header. API tokens are created in the dashboard and expire after 90 days; the dashboard warns you 14 days before expiry. Tokens can be revoked at any time.

## Rate limits

The Standard plan allows 600 requests per minute per token, and the Enterprise plan allows 3000 requests per minute. When the limit is exceeded the API returns HTTP 429 together with a `Retry-After` header that tells you how many seconds to wait. Clients should back off exponentially and add jitter to avoid retry storms.

## Pagination

List endpoints use cursor-based pagination. The `limit` parameter accepts values up to 100 and defaults to 20. The response contains a `next_cursor` field; when it is null there are no more results.

## Idempotency

Write endpoints accept an `Idempotency-Key` header. Repeating a request with the same key within 24 hours returns the original response instead of performing the operation again. Reusing a key with a different request body returns HTTP 422.

## Webhooks

Webhooks are signed with an HMAC-SHA256 signature in the `Northwind-Signature` header. If your endpoint does not respond with a 2xx status, delivery is retried 5 times with exponential backoff over about 24 hours. After the final failure the webhook endpoint is automatically disabled and an email is sent to the account owner.

## Errors

Errors use a consistent JSON body with `code`, `message` and `request_id` fields. Always include the `request_id` when contacting support.
