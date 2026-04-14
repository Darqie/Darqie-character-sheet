// @ts-ignore Deno module
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const INVIDIOUS_INSTANCES = [
  "https://inv.thepixora.com",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, range",
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
        // Prefer mp4/m4a over webm — mp4 has seeking index at the start of the file,
        // while webm Cues are at the end, making seeking through a proxy impossible.
        const aIsMp4 = a.type?.includes("mp4") ? 1 : 0;
        const bIsMp4 = b.type?.includes("mp4") ? 1 : 0;
        if (bIsMp4 !== aIsMp4) return bIsMp4 - aIsMp4;
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

// In-memory cache for resolved URLs (persists across invocations in same isolate)
const urlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCachedUrl(videoId: string): string | null {
  const entry = urlCache.get(videoId);
  if (entry && entry.expiresAt > Date.now()) return entry.url;
  urlCache.delete(videoId);
  return null;
}

function setCachedUrl(videoId: string, url: string) {
  urlCache.set(videoId, { url, expiresAt: Date.now() + CACHE_TTL });
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
    // Use cached URL for stream requests (Range seeks) to avoid re-resolving
    let audioUrl = stream ? getCachedUrl(videoId) : null;
    let result: { url: string; bitrate: number; codec: string };

    if (audioUrl) {
      result = { url: audioUrl, bitrate: 0, codec: "cached" };
    } else {
      result = await resolveAudioUrl(videoId);
      setCachedUrl(videoId, result.url);
    }

    if (!stream) {
      return new Response(
        JSON.stringify(result),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Stream mode: proxy the audio bytes back to the client
    const fetchHeaders: Record<string, string> = {};
    const rangeHeader = req.headers.get("range");
    if (rangeHeader) fetchHeaders["Range"] = rangeHeader;

    let audioResp = await fetch(result.url, { headers: fetchHeaders });

    // If cached URL expired (403/410), invalidate cache and re-resolve
    if ((audioResp.status === 403 || audioResp.status === 410) && audioUrl) {
      urlCache.delete(videoId);
      const fresh = await resolveAudioUrl(videoId);
      setCachedUrl(videoId, fresh.url);
      audioResp = await fetch(fresh.url, { headers: fetchHeaders });
    }

    if (!audioResp.ok && audioResp.status !== 206) {
      return new Response(
        JSON.stringify({ error: `Audio fetch failed: HTTP ${audioResp.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    if (!audioResp.body) {
      return new Response(
        JSON.stringify({ error: "No response body" }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const contentType = audioResp.headers.get("content-type") || "audio/webm";
    const contentRange = audioResp.headers.get("content-range");
    const respHeaders: Record<string, string> = {
      ...corsHeaders,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600",
    };

    if (rangeHeader) {
      // Range request — stream through with proper headers
      const contentLength = audioResp.headers.get("content-length");
      if (contentLength) respHeaders["Content-Length"] = contentLength;
      if (contentRange) respHeaders["Content-Range"] = contentRange;
      return new Response(audioResp.body, {
        status: audioResp.status,
        headers: respHeaders,
      });
    }

    // Initial (non-Range) request — buffer fully so Content-Length is accurate.
    // Without Content-Length the browser treats it as a stream and cannot seek.
    const body = await audioResp.arrayBuffer();
    respHeaders["Content-Length"] = String(body.byteLength);

    return new Response(body, {
      status: 200,
      headers: respHeaders,
    });
  } catch (e: any) {
    return new Response(
      JSON.stringify({ error: e?.message || "unknown" }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
