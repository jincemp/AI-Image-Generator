date: 2026-10-25
agent: unassigned
task: Check the code before the owner makes some changes
outcome: investigated
files_changed: 0

## What I found

The server works for the normal case. I ran it against a fake OpenAI
endpoint: initialize, tools/list and generate_image all behave as expected,
and OpenAI errors (such as a 400) come back to the client as readable tool
errors.

Problems, most important first:

1. Unknown session IDs get HTTP 400, not 404 (server.js:118-124 and
   server.js:146-148). Sessions live only in memory, so every restart,
   redeploy or sleep of the host forgets them. The MCP spec says clients
   start a new session only when they get a 404. With a 400, a connected
   client stays stuck until the user reconnects by hand. The SDK's own
   transport uses 404 with code -32001 "Session not found" for this case.
2. Sessions are only removed when the client sends DELETE
   (server.js:94, 112-114). Clients that just disconnect leave their
   session in memory for as long as the process runs.
3. If OpenAI returns no image, the user sees
   "Cannot read properties of undefined (reading 'b64_json')"
   (server.js:69) instead of a clear message.
4. The OpenAI call has no time limit (server.js:46).
5. Small tidy-ups: the size and quality defaults are written twice
   (server.js:55-56 and 70-71); the 500 error uses a random UUID as the
   JSON-RPC id instead of null (server.js:135).
6. No package-lock.json is committed, so each deploy can install different
   dependency versions.
7. The README does not say which environment variables to set
   (OPENAI_API_KEY, MCP_SECRET, optional PORT) or what URL to give a client.
8. The secret in the URL is the only access control. Anyone who has the URL
   can spend the OpenAI balance.

## What I changed

Nothing in the source. This log entry is the only new file.

## What I did not do, and why

I did not fix anything. The owner asked for a check first and said they want
to make their own changes, so I reported the findings and waited for them.
I did not check the per-image prices in the tool description against
OpenAI's current price list.

## What the next session should know

- Test without spending money: start the server with
  `node --import <mock> server.js`, where the mock module replaces
  `globalThis.fetch` for api.openai.com. Set OPENAI_API_KEY to any value and
  MCP_SECRET to a test value.
- The first two findings are the ones that affect real users. They are
  small fixes in server.js.
