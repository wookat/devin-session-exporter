# Devin session share Worker

This Worker provides a live, one-session cross-profile share. It stores the
login state and `devinId` encrypted at rest with AES-GCM, then uses that state
on each `GET /s/:id` to read only the linked Devin session. It never exposes
the login state in the response. The generated 128-bit random ID is the
capability that grants access, so treat share URLs like secrets.

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

5. Set the encryption secret:

   ```sh
   wrangler secret put SHARE_KEY
   ```

`SHARE_KEY` is required and must not be committed to this repository. The
default live-share lifetime is 24 hours. Set `SHARE_TTL_SECONDS` in
`wrangler.toml` (or as a deployment environment variable) to change it.

Configure the deployed Worker URL in the extension's
`分享服务地址（Worker URL）` setting. `POST /share` and `DELETE /s/:id` accept
requests from `https://app.devin.ai`. POST accepts `{ token, orgId, devinId }`
and encrypts those values in KV; `devinId` may be the `devin-<id>` form, a
session URL, or a bare ID. `GET /s/:id` fetches the linked session live from
Devin and returns readable markdown, scoped to that one session only.
`DELETE /s/:id` revokes a share before its TTL expires. If the stored Devin
token expires, the live link stops working.
