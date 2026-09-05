# Vendored browser libraries

Self-hosted because the admin CSP allows no CDNs. Each ships verbatim from
its npm package with its license alongside.

| Library | Version | License | Source package |
|---|---|---|---|
| Mermaid | 11.17.2 | MIT (`mermaid.LICENSE`) | `mermaid` |
| KaTeX   | 0.16.47 | MIT (`katex.LICENSE`)   | `katex` (js/css + woff2 fonts) |

`katex.min.css` references woff/ttf fallbacks that are deliberately not
shipped — every supported browser takes the woff2 path.

Update: `npm pack mermaid@X katex@Y`, copy `dist/` artifacts + LICENSE,
bump this table.
