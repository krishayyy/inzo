# Third-party logos

Marks for the "model agnostic" marquee on the landing page.

## What is here and where it came from

| File | Shown as | Source | Colour |
|---|---|---|---|
| `claude.svg` | Claude Code | [svgl](https://svgl.app) → anthropic.com/brand | `#D97757` |
| `codex.svg` | Codex | [svgl](https://svgl.app) → openai.com/brand | `#000000` |
| `cursor.svg` | Cursor | [Simple Icons](https://simpleicons.org) | `#000000` |
| `qwen.svg` | Qwen | [Simple Icons](https://simpleicons.org) | `#6950EF` |
| `ollama.svg` | Ollama | [Simple Icons](https://simpleicons.org) | `#000000` |

Colours are each brand's own. Only Claude and Qwen have a colour in their
identity at all — OpenAI, Cursor, and Ollama are black-and-white brands, so
they are black here rather than tinted into something they are not.

Each file was checked to contain nothing but path data: no `<script>`, no
`<foreignObject>`, no remote references.

## How the marquee picks these up

Each item in `../../index.html` carries a `data-logo` name. On load, `app.js`
probes `brand/logos/<data-logo>.svg`:

- **File exists** → the mark is prepended next to the name.
- **File missing** → just the name shows. No broken image, no layout shift.

So adding or swapping a logo is only ever a file operation — no markup change.

## Adding another

1. Save the official SVG as `<name>.svg` here.
2. Add one `<li class="marquee-item" data-logo="<name>" data-label="<Name>">Name</li>`
   to the row in `index.html`.

Only add a client Inzo genuinely works with. The row sits under a claim, and
the product's whole argument is that its claims are checkable.

## Sizing

Rendered at `height: 22px`, `width: auto` (20px on mobile), so any aspect ratio
works. Prefer a tight `viewBox` — padding baked into the file makes that logo
look smaller than its neighbours.

The name stays visible beside the mark, so each `<img>` is decorative and gets
`alt=""`. Giving it real alt text would make screen readers announce every
client twice.

## Licensing note

Showing a mark to say "this works with that" is ordinary nominative use. Follow
each brand's guidelines on clear space and on not implying endorsement or
partnership. Note that these are used at their own colours precisely because
several of these guidelines discourage recolouring.
