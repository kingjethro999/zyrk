# zyrk website

This Next.js app is the project website. The app lives in `web/`, uses the
repository's zyrk package manager workflow, and is configured for Vercel in
[`vercel.json`](vercel.json).

## Run locally

From the repository root, bootstrap zyrk once and install the site dependencies:

```bash
npm install --global zyrk@0.6.6
cd web
zyrk install --frozen-lockfile
zyrk run dev
```

Open <http://localhost:3000>. Use `zyrk run build` to verify a production
build and `zyrk run start` to serve that build locally.

## Deploy to Vercel

Create a Vercel project from this repository and set its **Root Directory** to
`web`. Vercel reads the install and build commands from `vercel.json`; they
bootstrap zyrk with npm, install the site graph with zyrk, and build through
the project's `zyrk run build` script. The app requires Node.js 24 or newer.

The site is in active development; framework compatibility is verified by the
repository's checks and smoke tests rather than assumed from the scaffold.
