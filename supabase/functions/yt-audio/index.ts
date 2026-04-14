import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const PIPED_INSTANCES = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi-libre.kavin.rocks",
  "https://pipedapi.leptons.xyz",
  "https://piped-api.privacy.com.de",
  "https://pipedapi.adminforge.de",
  "https://api.piped.yt",
  "https://pipedapi.drgns.space",
  "https://pipedapi.ducks.party",
  "https://pipedapi.darkness.services",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const videoId = url.searchParams.get("v");

  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return new Response(JSON.stringify({ error: "Invalid video ID" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const errors: string[] = [];

  for (const instance of PIPED_INSTANCES) {
    try {
      const r = await fetch(
        `${instance}/streams/${encodeURIComponent(videoId)}`
      );
      if (!r.ok) {
        errors.push(`${instance}: HTTP ${r.status}`);
        continue;
      }
      const json = await r.json();
      const streams = Array.isArray(json.audioStreams)
        ? json.audioStreams
        : [];
      const best = streams
        .filter((s: any) => s.url && s.mimeType?.startsWith("audio/"))
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
      if (best?.url) {
        return new Response(
          JSON.stringify({
            url: best.url,
            bitrate: best.bitrate,
            codec: best.codec,
          }),
          {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
      errors.push(`${instance}: no audio streams`);
    } catch (e: any) {
      errors.push(`${instance}: ${e?.message || "unknown error"}`);
      continue;
    }
  }

  return new Response(JSON.stringify({ error: "All instances failed", details: errors }), {
    status: 502,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
