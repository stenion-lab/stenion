// A protocol's mark, or a deliberate stand-in when it has none.
//
// THE TILE IS THE POINT. Every logo renders inside a fixed-size rounded tile
// with the SAME dark fill in both themes, and that is a deliberate departure
// from the themed palette in globals.css.
//
// Why not a themed surface token: protocol marks are supplied as-is and many
// assume one background. Kinetic's icon ships an opaque #0a0816 square baked
// into the PNG, so a light tile in light theme would frame a dark square in a
// pale box; Blend's is a transparent SVG that happens to read on both. A tile
// that flipped with the theme would therefore need a hand-recoloured variant of
// each mark — i.e. altering someone's logo, which is precisely what the
// attribution note below the listings says we don't do. A constant dark tile
// presents every mark unmodified, on a background each one already works on.
//
// It also removes a whole class of bug: no per-logo "needs a backdrop" flag to
// get wrong, and the no-logo fallback is the same tile with initials in it, so
// there is no visual seam between a protocol that has a mark and one that
// doesn't.

import { cn } from '../app/lib/cn';

/**
 * Exactly the background baked into Kinetic's icon PNG (sampled corner-to-
 * corner), so that mark's opaque square dissolves into the tile instead of
 * showing a visible inner edge. Dark enough that a white-on-transparent mark
 * like Blend's reads against it too.
 *
 * A literal rather than a `--t-*` token on purpose: those tokens exist to swap
 * with the theme, and this one must NOT. Putting it there would advertise a
 * capability that would break both marks if anyone used it.
 */
const TILE_BG = '#0a0816';

/**
 * Up to two letters standing in for a missing mark, e.g. "Blend" → "BL",
 * "Yield Blox" → "YB".
 *
 * Never empty: a protocol row must not render a blank square. Falls back to "?"
 * for a name with no alphanumerics at all, which is the honest rendering of a
 * name we can't abbreviate.
 */
export function initialsFor(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

export interface ProtocolLogoProps {
  /** protocol name — used for the accessible name and for fallback initials */
  name: string;
  /** root-relative path under public/, or null when the protocol has no usable mark */
  logo: string | null;
  /** rendered edge length in px; width AND height are fixed so nothing reflows */
  size?: number;
  className?: string;
}

export function ProtocolLogo({ name, logo, size = 40, className }: ProtocolLogoProps) {
  return (
    <div
      aria-hidden="true"
      className={cn('shrink-0 overflow-hidden rounded-xl', className)}
      // Fixed dimensions in inline style, and matching width/height on the <img>
      // below, so the box occupies its final size on first paint. A slow or
      // failed asset load then changes nothing about the layout — which matters
      // most on the registry, where a shift would move the row a reader is
      // already pointing at. `shrink-0` stops a flex parent squashing it.
      //
      // The inset hairline gives the tile a visible edge in DARK theme, where
      // TILE_BG is very close to the page background and the tile would
      // otherwise dissolve, leaving marks apparently floating. Inset rather
      // than a border so it costs no layout box and cannot shift the mark.
      style={{
        width: size,
        height: size,
        background: TILE_BG,
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.09)',
      }}
    >
      {logo === null ? (
        <span
          aria-hidden="true"
          className="flex h-full w-full items-center justify-center font-display font-semibold tracking-tight text-white/70"
          // Scaled off `size` so one component serves the 40px registry row and
          // the 64px detail hero without a second set of type classes.
          style={{ fontSize: Math.round(size * 0.34) }}
        >
          {initialsFor(name)}
        </span>
      ) : (
        <img
          src={logo}
          // Names the protocol, per the brief. The row/hero always renders the
          // name as text as well, so the mark is never the only identification —
          // this is belt-and-braces for a reader who gets the alt and not the
          // layout (feed readers, text browsers, images-off).
          alt={`${name} logo`}
          width={size}
          height={size}
          // `contain` keeps a non-square mark from being stretched into the
          // square tile. The padding insets a transparent mark from the edges;
          // an opaque one that already fills its own square (Kinetic) still
          // reads flush, because the tile behind it is the same colour.
          className="h-full w-full object-contain p-[12%]"
          // These assets ship in this repo's public/ tree, so they are same-
          // origin and versioned with the build — but decoding stays async and
          // off the critical path since the tile is already drawn.
          decoding="async"
          loading="lazy"
        />
      )}
    </div>
  );
}

/**
 * The line that has to appear wherever protocol marks or protocol links do.
 *
 * Not boilerplate, and not a legal reflex either. Stenion publishes a number a
 * protocol may well dislike, directly beside that protocol's own mark and a
 * link to its site. Both could be read as association or as a recommendation.
 * Saying plainly that neither is meant that way costs one line and removes the
 * ambiguity; the analysis itself stands on METHODOLOGY.md, not on goodwill.
 *
 * It covers LINKS as well as marks on purpose — linking to a protocol is no more
 * an endorsement of it than showing its logo is, and a note that mentioned only
 * logos would imply the links meant something else.
 */
export function MarkAttribution({ className }: { className?: string }) {
  return (
    <p className={cn('text-xs leading-relaxed text-faint', className)}>
      Protocol names, logos and trademarks belong to their respective owners and are shown for
      identification only. Their presence here and any link to a protocol&apos;s own site or
      documentation does not imply endorsement, partnership, or any relationship with Stenion, in
      either direction.
    </p>
  );
}
