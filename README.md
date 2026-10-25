# AI-Image-Generator

An MCP server that makes and edits images with OpenAI's image models. Add it
to Claude (or any MCP client) as a remote connector. Every result tells you
what the request cost.

## Set it up

1. Install: `npm install`
2. Set these environment variables:

   | Variable | Required | What it does |
   | --- | --- | --- |
   | `OPENAI_API_KEY` | Yes | Your OpenAI API key. |
   | `MCP_SECRET` | Yes | A long random string. It becomes part of the server address and is the only thing protecting it. |
   | `PORT` | No | Port to listen on. Defaults to 3000. |
   | `SESSION_IDLE_MINUTES` | No | Close client sessions unused for this long. Defaults to 30. |
   | `IMAGE_CACHE_MB` | No | Memory for recent images that `edit_image` can reuse by ID. Defaults to 100. |

3. Start: `npm start`
4. In your MCP client, add the connector address
   `https://<your-host>/mcp/<MCP_SECRET>`.

Anyone who has that address can spend your OpenAI balance, so keep it
private. A spending limit on your OpenAI account adds a safety net.

## Tools

### `generate_image`

Makes images from a text prompt.

### `edit_image`

Changes images, or uses them as references for a new image. You give 1 to 16
images. Each one can be:

- an image ID from an earlier result, such as `img_1a2b3c4d5e6f`
- a public `http` or `https` link to the image
- the image as base64 text, plain or as a `data:` URL

Images must be PNG, JPEG or WebP and under 50 MB each. You can also give a
`mask`: a PNG whose fully transparent areas mark where to edit.

Image IDs are kept in memory only. They stop working when the server
restarts, or once newer images push them out of the `IMAGE_CACHE_MB` limit.

### Options for both tools

| Option | Values | Default |
| --- | --- | --- |
| `model` | `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-1.5`, `gpt-image-1-mini`, `chatgpt-image-latest` | `gpt-image-2` |
| `quality` | `low`, `medium`, `high`, `auto`; also `xhigh` and `max` on the 2.5 models | `medium` |
| `size` | `1024x1024`, `1536x1024`, `1024x1536`, `auto`, or a custom `WIDTHxHEIGHT` on `gpt-image-2` and the 2.5 models | `1024x1024` |
| `n` | 1 to 10 images | 1 |
| `background` | `auto`, `opaque`, `transparent` (needs `png` or `webp`) | `auto` |
| `output_format` | `png`, `jpeg`, `webp` | `png` |
| `output_compression` | 0 to 100, for `jpeg` and `webp` | 100 |

`generate_image` also takes `moderation` (`auto` or `low`). `edit_image`
also takes `input_fidelity` (`low` or `high`) for `gpt-image-1.5`, and `low`
only for `gpt-image-1-mini`.

Custom sizes need both sides divisible by 16 and an aspect ratio between 1:3
and 3:1. The largest is 3840x2160, and anything above 2560x1440 is
experimental.

## Cost

Each result ends with a line like this:

```text
Cost: $0.0528 (20 text input, 1756 image output tokens).
```

The server works this out from the token counts OpenAI sends back and the
prices in the `PRICES` table at the top of `server.js`. Those prices were
checked on 25 October 2026. Update the table when OpenAI changes its prices.
It does not include the 10% extra OpenAI charges for regional data
processing.

As a guide, one 1024x1024 image with `gpt-image-2` costs about $0.006 at
`low`, $0.053 at `medium` and $0.211 at `high` quality.

## Slow images

Top-quality images can take a few minutes. The server waits up to 5 minutes
for OpenAI. Clients that ask for progress updates get one every 15 seconds,
so they know the request is still running.
