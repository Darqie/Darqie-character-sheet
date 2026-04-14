import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
  "https://inv.thepixora.com",
  "https://yt.chocolatemoo53.com",
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

  // Race all Invidious instances in parallel with 8s timeout each
  const results = await Promise.allSettled(
    INVIDIOUS_INSTANCES.map(async (instance) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const r = await fetch(
          `${instance}/api/v1/videos/${encodeURIComponent(videoId)}?fields=adaptiveFormats&local=true`,
          { signal: controller.signal }
        );
        clearTimeout(timer);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json();
        const formats = Array.isArray(json.adaptiveFormats) ? json.adaptiveFormats : [];
        const best = formats
          .filter((f: any) => f.url && f.type?.startsWith("audio/"))
          .sort((a: any, b: any) => {
            const ba = parseInt(String(a.bitrate || "0"), 10);
            const bb = parseInt(String(b.bitrate || "0"), 10);
            return bb - ba;
          })[0];
        if (!best?.url) throw new Error("no audio streams");
        // Ensure the URL goes through the Invidious proxy (not direct googlevideo.com)
        let audioUrl = best.url;
        if (audioUrl.includes("googlevideo.com")) {
          // Construct proxied URL through the Invidious instance
          const itag = best.itag || audioUrl.match(/itag=(\d+)/)?.[1];
          if (itag) {
            audioUrl = `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
          }
        }
        const codec = best.encoding || best.type?.match(/codecs="([^"]+)"/)?.[1] || "unknown";
        return { url: audioUrl, bitrate: parseInt(String(best.bitrate || "0"), 10), codec };
      } catch (e: any) {
        clearTimeout(timer);
        throw new Error(`${instance}: ${e?.message || "unknown"}`);
      }
    })
  );

  // Return first successful result
  for (const r of results) {
    if (r.status === "fulfilled") {
      return new Response(
        JSON.stringify(r.value),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    errors.push(r.reason?.message || "unknown");
  }

  return new Response(
    JSON.stringify({ error: "All instances failed", details: errors }),
    { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
