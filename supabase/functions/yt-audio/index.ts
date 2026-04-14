import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const INVIDIOUS_INSTANCES = [
  "https://inv.thepixora.com",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

async function fetchFromInstance(instance: string, videoId: string): Promise<{ url: string; bitrate: number; codec: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
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
    let audioUrl = best.url;
    const urlHost = new URL(audioUrl).hostname;
    if (urlHost.includes("googlevideo.com")) {
      const itag = best.itag || audioUrl.match(/itag=(\d+)/)?.[1];
      if (itag) {
        audioUrl = `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
      }
    }
    if (audioUrl.startsWith("http://")) {
      audioUrl = "https://" + audioUrl.slice(7);
    }
    const codec = best.encoding || best.type?.match(/codecs="([^"]+)"/)?.[1] || "unknown";
    return { url: audioUrl, bitrate: parseInt(String(best.bitrate || "0"), 10), codec };
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(`${instance}: ${e?.message || "unknown"}`);
  }
}

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

  // Try all instances in parallel
  const results = await Promise.allSettled(
    INVIDIOUS_INSTANCES.map((inst) => fetchFromInstance(inst, videoId))
  );

  for (const r of results) {
    if (r.status === "fulfilled") {
      return new Response(
        JSON.stringify(r.value),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    errors.push(r.reason?.message || "unknown");
  }

  // Retry once after 1s delay (transient failures)
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const retryResults = await Promise.allSettled(
    INVIDIOUS_INSTANCES.map((inst) => fetchFromInstance(inst, videoId))
  );

  for (const r of retryResults) {
    if (r.status === "fulfilled") {
      return new Response(
        JSON.stringify(r.value),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    errors.push(`retry: ${r.reason?.message || "unknown"}`);
  }

  return new Response(
    JSON.stringify({ error: "All instances failed", details: errors }),
    { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
