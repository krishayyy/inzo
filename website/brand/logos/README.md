# Third-party logos

Logos for the "works with" marquee on the landing page. **This directory is
empty on purpose** — nothing here is committed until someone drops in an
official asset.

## How the swap works

Each marquee item in `../../index.html` ships as a text wordmark and carries a
`data-logo` name. On load, `app.js` probes `brand/logos/<data-logo>.svg`:

- **File exists** → the wordmark is replaced by the logo, automatically.
- **File missing** → the wordmark stays. No broken image, no layout shift.

So adding a logo is just adding a file. No markup or CSS change.

## Filenames

| File | Replaces | Official source |
|---|---|---|
| `claude.svg` | Claude | anthropic.com/brand |
| `openai.svg` | Codex | openai.com/brand |
| `cursor.svg` | Cursor | cursor.com |
| `mcp.svg` | MCP | modelcontextprotocol.io |

Pull the real files from those brand pages rather than redrawing them. A mark
that is subtly the wrong proportion is more noticeable than no mark at all.

## Sizing

Rendered at `height: 24px` with `width: auto` (20px on mobile), so any aspect
ratio works. Prefer SVG with a tight `viewBox` — padding baked into the file
will make that logo look smaller than its neighbours.

## If the mixed brand colours look busy

Logos render in their own colours at `opacity: .55`, lifting to full on hover.
For a uniform monochrome row instead, swap `.logo-mark` in `../../styles.css`
to a mask so every logo picks up one ink colour:

```css
.logo-mark {
  height: 24px;
  width: var(--logo-w, 96px);
  background: var(--ink);
  -webkit-mask: var(--logo-src) center / contain no-repeat;
  mask: var(--logo-src) center / contain no-repeat;
}
```

That needs a per-logo width, since masking gives up intrinsic sizing.

## Licensing note

Showing a company's mark to say "this product works with that product" is
ordinary nominative use. Follow each brand's guidelines on clear space and on
not implying endorsement or partnership — most of the pages above spell this
out. Don't recolour a mark if its guidelines prohibit it.
