/**
 * Puts the two things the site serves from the monorepo into public/:
 *   public/app/    a fresh build of apps/web with base "/app/" (the web app)
 *   public/embed/  the @sketchor/embed build (<sketchor-view>, E-09)
 * plus public/app/version.json so the landing page can say which version the
 * browser app runs. Run before `next build` / `vercel deploy` — both outputs
 * are gitignored, and Vercel only sees this folder, not the monorepo.
 */
import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(site, "..", "..");
const web = join(repo, "apps", "web");
const embed = join(repo, "packages", "embed");
const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (${cwd.replace(repo, ".")})`);
  execSync(cmd, { cwd, stdio: "inherit" });
};

if (!existsSync(join(repo, "node_modules"))) run("npm install", repo);
run("npm run build --workspace @sketchor/core", repo);

// Web app: same build as `npm run build`, but rooted at /app/ instead of "./".
run("npx tsc --noEmit", web);
run("npx vite build --base /app/ --outDir dist-site --emptyOutDir", web);
const appOut = join(site, "public", "app");
rmSync(appOut, { recursive: true, force: true });
cpSync(join(web, "dist-site"), appOut, { recursive: true });
rmSync(join(web, "dist-site"), { recursive: true, force: true });
const version = JSON.parse(readFileSync(join(web, "package.json"), "utf8")).version;
writeFileSync(join(appOut, "version.json"), JSON.stringify({ version, builtAt: new Date().toISOString() }) + "\n");

// Embed.
run("npx vite build", embed);
const embedOut = join(site, "public", "embed");
rmSync(embedOut, { recursive: true, force: true });
mkdirSync(embedOut, { recursive: true });
cpSync(join(embed, "dist"), embedOut, { recursive: true });

console.log(`\nbundled web app v${version} -> public/app, embed -> public/embed`);
