date: 2026-10-25
agent: unassigned
task: Review the code, fix the two session problems, add every OpenAI image option, image input and cost reporting
outcome: shipped
files_changed: 2

## What I found

The server worked for the normal case. The review found two problems that
affect real users:

1. Unknown session IDs got HTTP 400, not 404. Sessions live only in memory,
   so every restart, redeploy or sleep forgets them. The MCP spec says
   clients start a new session only on a 404, so clients stayed stuck until
   someone reconnected by hand.
2. Sessions were only removed when the client sent DELETE, so sessions from
   clients that just disconnected piled up in memory.

Smaller findings: a confusing error when OpenAI returned no image, no time
limit on the OpenAI call, defaults written twice, and a random JSON-RPC id on
internal errors.

What OpenAI offers now (checked against the openai npm package 7.43.0 and
https://developers.openai.com/api/docs/pricing on 25 October 2026):

- gpt-image-1 was shut down on 23 October 2026. DALL-E models are retired.
- Current models: gpt-image-2, gpt-image-2.5-flare, gpt-image-2.5-sunburst,
  gpt-image-1.5, gpt-image-1-mini, chatgpt-image-latest.
- OpenAI bills per token and returns a usage object, so the exact cost can be
  worked out per request. Cached-input prices do not apply to the Images API.
- /v1/images/edits takes multipart uploads only (field `image[]`, up to 16).
- platform.openai.com blocks automated fetches. developers.openai.com works.

## What I changed

- server.js: unknown session IDs now get 404 with code -32001. Sessions idle
  for SESSION_IDLE_MINUTES (default 30) are closed.
- server.js: new edit_image tool. Images can be IDs of images the server made
  earlier, http(s) URLs, or base64. Supports mask and input_fidelity.
- server.js: both tools take model, quality (with xhigh and max), custom
  sizes, n, background, output_format, output_compression; generate_image
  also takes moderation.
- server.js: every result reports its cost from OpenAI's token usage and a
  PRICES table. Each image gets an ID kept in memory (IMAGE_CACHE_MB,
  default 100).
- server.js: 5-minute time limit on OpenAI calls, a clear error when no image
  comes back, and progress updates every 15 seconds for clients that ask.
- README.md: setup, tools, options and cost.

Tested against a fake OpenAI endpoint: 7 session checks and 15 tool checks,
all passing. Not tested against the real OpenAI API, because this
environment has no API key.

## What I did not do, and why

- Did not test with real OpenAI calls (no key here). The first real call of
  each tool should be checked, especially edit_image's upload format.
- Did not add streaming partial images. An MCP tool result arrives in one
  piece, so partial images would not reach the user.
- Did not add safety_identifier or user. They are for apps with many end
  users, not for a personal connector.
- Did not commit package-lock.json. That changes what deploys install and is
  the owner's decision.
- Images uploaded in a Claude chat cannot easily be passed to edit_image.
  Claude can pass an image ID, a link, or base64 it already has as text.

## What the next session should know

- The owner asked how to get images uploaded in a Claude chat into
  edit_image. Remote MCP tools cannot read chat attachments: Claude only
  passes text it writes, and it cannot write out an image's bytes. Options
  researched, not built yet:
  1. Upload link: a tool returns a one-time URL plus the future image ID.
     Claude's code environment (code execution and file creation, files in
     /mnt/user-data/uploads per Higgsfield's connector) can PUT the file with
     curl. This needs network access to the server's domain, which may be
     off or limited to package managers. Opened in a browser, the same link
     can show an upload page, which works on any device.
  2. In-chat upload box (MCP Apps, @modelcontextprotocol/ext-apps 2.0.3): the
     widget can call an app-only tool with callServerTool and tell Claude the
     ID with updateModelContext or sendMessage. Claude supports MCP Apps.
     More work, and it cannot be tested here without a real Claude host.
  Higgsfield's connector uses both: link first, box as the fallback.

- Test without spending money: start the server with
  `node --import <mock> server.js`, where the mock module replaces
  `globalThis.fetch` for api.openai.com. Set OPENAI_API_KEY to any value and
  MCP_SECRET to a test value.
- The PRICES table in server.js must be updated by hand when OpenAI changes
  its prices.
- The SDK client gives up after 60 seconds by default unless the client app
  turns on resetTimeoutOnProgress. Slow, top-quality images may hit that in
  some clients.
