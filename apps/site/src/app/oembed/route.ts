import { oembedFor } from "@/lib/embedFrame";

/**
 * oEmbed provider (https://oembed.com): `/oembed?url=<a /embed page, a
 * /app?open= link or a model URL>&maxwidth=&maxheight=` answers a "rich"
 * embed whose HTML is an iframe of the /embed endpoint. JSON only.
 */
const CORS = { "Access-Control-Allow-Origin": "*" };

export function GET(request: Request): Response {
  const q = new URL(request.url).searchParams;
  const format = q.get("format");
  if (format && format !== "json") return new Response("Only format=json is supported", { status: 501, headers: CORS });
  const url = q.get("url");
  if (!url) return new Response("Missing url", { status: 400, headers: CORS });
  const num = (k: string): number | undefined => {
    const n = Number(q.get(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const body = oembedFor(url, num("maxwidth"), num("maxheight"));
  if (!body) return new Response("Not a Sketchor preview URL", { status: 404, headers: CORS });
  return Response.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=86400" } });
}
