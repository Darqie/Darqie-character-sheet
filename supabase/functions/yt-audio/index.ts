// @ts-ignore Deno module
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
    const itag = best.itag || best.url.match(/itag=(\d+)/)?.[1];
    if (!itag) throw new Error("no itag found");
    // Always use /latest_version — the /videoplayback proxy returns 403
    const audioUrl = `${instance}/latest_version?id=${encodeURIComponent(videoId)}&itag=${itag}&local=true`;
    const codec = best.encoding || best.type?.match(/codecs="([^"]+)"/)?.[1] || "unknown";
    return { url: audioUrl, bitrate: parseInt(String(best.bitrate || "0"), 10), codec };
  } catch (e: any) {
    clearTimeout(timer);
    throw new Error(`${instance}: ${e?.message || "unknown"}`);
  }
}

async function resolveAudioUrl(videoId: string): Promise<{ url: string; bitrate: number; codec: string }> {
  const errors: string[] = [];

  const results = await Promise.allSettled(
    INVIDIOUS_INSTANCES.map((inst) => fetchFromInstance(inst, videoId))
  );
  for (const r of results) {
    if (r.status === "fulfilled") return r.value;
    errors.push(r.reason?.message || "unknown");
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const retryResults = await Promise.allSettled(
    INVIDIOUS_INSTANCES.map((inst) => fetchFromInstance(inst, videoId))
  );
  for (const r of retryResults) {
    if (r.status === "fulfilled") return r.value;
    errors.push(`retry: ${r.reason?.message || "unknown"}`);
  }

  throw new Error(`All instances failed: ${errors.join("; ")}`);
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const videoId = url.searchParams.get("v");
  const stream = url.searchParams.get("stream") === "1";

  if (!videoId || !/^[\w-]{6,20}$/.test(videoId)) {
    return new Response(JSON.stringify({ error: "Invalid video ID" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const result = await resolveAudioUrl(videoId);

    if (!stream) {
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Stream mode: proxy the audio bytes back to the client
    const audioResp = await fetch(result.url);
    if (!audioResp.ok || !audioResp.body) {
      return new Response(
        JSON.stringify({ error: `Audio fetch failed: HTTP ${audioResp.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contentType = audioResp.headers.get("content-type") || "audio/webm";
    const contentLength = audioResp.headers.get("content-length");
    const headers: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    };
    if (contentLength) headers["Content-Length"] = contentLength;

    return new Response(audioResp.body, { headers });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || "unknown" }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
