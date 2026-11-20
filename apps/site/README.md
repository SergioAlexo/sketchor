# sketchor.sergioalexo.com

The landing page (Next.js) plus the web app served at `/app` and the
`<sketchor-view>` embed at `/embed`. Not an npm workspace on purpose — it uses
React 19 / Next 16 while `apps/web` is on React 18.

```bash
cd apps/site
npm install
npm run bundle   # builds apps/web with base /app/ -> public/app, packages/embed -> public/embed
npm run dev      # http://localhost:3007
npm run deploy   # bundle + `vercel deploy --prod` (Vercel project: sketchor-site)
```

- Release version, installer link, size and date come from the latest GitHub
  release at build time and revalidate hourly (`src/lib/release.ts`), so a new
  tag shows up without redeploying. The "running vX" line for the browser app
  reads `public/app/version.json`, written by the bundle step.
- `public/app` and `public/embed` are build output (gitignored). Vercel only
  receives this folder, so always deploy with `npm run deploy` (or run
  `npm run bundle` first).
- `/app?open=<url>` opens a file in the web app (E-06); `public/models/bracket.glb`
  is the embed demo model.
- `/embed?src=<file URL>&motion=&theme=&…` is the iframe endpoint (E-02): one
  full-bleed `<sketchor-view>` for sites that can't run scripts. Query values
  are validated in `src/lib/embedFrame.ts` (tested from the repo root with
  `npx vitest run apps/site`); `/embed` without `src` redirects to `/#embed`.
- `/oembed?url=<an /embed page, a /app?open= link or a model URL>` is the
  oEmbed provider (JSON, type `rich`, an iframe of `/embed`); `/embed` pages
  advertise it with a discovery `<link>`.
- `npm run dev` for route work — `npm run start` serves the last `next build`.
