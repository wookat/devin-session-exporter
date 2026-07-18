# Devin session share Worker

This Worker stores read-only handoff snapshots for cross-profile sharing. It
never receives or stores Devin credentials. The generated 128-bit random ID is
the capability that grants access to a snapshot, so treat share URLs like
secrets.

## Deploy

1. Install Wrangler and authenticate:

   ```sh
   npm install -g wrangler
   wrangler login
   ```

2. Create a KV namespace:

   ```sh
   wrangler kv namespace create SHARES
   ```

3. Copy the returned namespace ID into `wrangler.toml` in place of
   `REPLACE_WITH_KV_NAMESPACE_ID`.

4. Deploy from this directory:

   ```sh
   cd worker
   wrangler deploy
   ```

The default snapshot lifetime is 24 hours. Set `SHARE_TTL_SECONDS` in
`wrangler.toml` (or as a deployment environment variable) to change it. The
Worker rejects content larger than 2 MiB.

Configure the deployed Worker URL in the extension's
`分享服务地址（Worker URL）` setting. `POST /share` and `DELETE /s/:id` accept
requests from `https://app.devin.ai`; `GET /s/:id` returns the markdown
snapshot directly so a Devin agent can fetch it. `DELETE /s/:id` revokes a
share before its TTL expires.
