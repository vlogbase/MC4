import type { Express } from "express";
import { createServer, type Server } from "http";
import axios from "axios";
import { db } from "@db";
import { links } from "@db/schema";
import { eq } from "drizzle-orm";
import { setupAuth, authenticateRequest } from "./auth";

// In-memory cache for rewriting
const urlCache = new Map<
  string, // `${userId}:${originalUrl}:${source}`
  {
    rewrittenUrl: string;
    timestamp: number;
  }
>();
const CACHE_TTL = 3600000; // 1 hour in ms

function isAmazonUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    return parsedUrl.hostname.includes('amazon.');
  } catch {
    return false;
  }
}

function appendAmazonAffiliateTag(url: string): string {
  try {
    const parsedUrl = new URL(url);
    const affiliateTag = 'turbofiliates-21';

    // If URL already has parameters, append with &, otherwise use ?
    const separator = parsedUrl.search ? '&' : '?';
    return `${url}${separator}tag=${affiliateTag}`;
  } catch {
    return url; // If URL parsing fails, return original
  }
}

async function getRewrittenUrl(
  originalUrl: string,
  userId: number,
  source: string
): Promise<string> {
  const cacheKey = `${userId}:${originalUrl}:${source}`;
  const cached = urlCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.rewrittenUrl;
  }

  // Not in cache => call Strackr
  try {
    const resp = await axios.get("https://api.strackr.com/v3/tools/linkbuilder", {
      params: {
        api_id: process.env.STRACKR_API_ID,
        api_key: process.env.STRACKR_API_KEY,
        url: originalUrl,
      },
    });
    const data = resp.data;
    let trackingLink: string | undefined;
    const [first] = data.results || [];
    if (first?.advertisers?.length) {
      const adv = first.advertisers[0];
      if (adv.connections?.length) {
        const conn = adv.connections[0];
        if (conn.links?.length) {
          trackingLink = conn.links[0].trackinglink;
        }
      }
    }

    // If no Strackr link found, check if it's Amazon
    if (!trackingLink) {
      if (isAmazonUrl(originalUrl)) {
        trackingLink = appendAmazonAffiliateTag(originalUrl);
      } else {
        trackingLink = originalUrl; // Fallback to original URL
      }
    }

    // Store in in-memory cache
    urlCache.set(cacheKey, { rewrittenUrl: trackingLink, timestamp: Date.now() });

    // Also store in DB
    await db.insert(links).values({
      userId,
      originalUrl,
      rewrittenUrl: trackingLink,
      source,
    });

    return trackingLink;
  } catch (error: any) {
    console.error("Strackr linkbuilder error:", error?.message || error);

    // If API call fails, try Amazon or return original
    if (isAmazonUrl(originalUrl)) {
      const amazonLink = appendAmazonAffiliateTag(originalUrl);

      // Store in cache and DB even for Amazon links
      urlCache.set(cacheKey, { rewrittenUrl: amazonLink, timestamp: Date.now() });
      await db.insert(links).values({
        userId,
        originalUrl,
        rewrittenUrl: amazonLink,
        source,
      });

      return amazonLink;
    }

    // Last resort: return original URL
    return originalUrl;
  }
}

async function fetchStrackrStats(endpoint: string, params: Record<string, string>) {
  const resp = await axios.get(`https://api.strackr.com/v3/${endpoint}`, {
    params: {
      api_id: process.env.STRACKR_API_ID,
      api_key: process.env.STRACKR_API_KEY,
      ...params,
    },
  });
  return resp.data;
}

export function registerRoutes(app: Express): Server {
  // Set up local+token auth
  setupAuth(app);

  /**
   * GPT endpoints => now accept BOTH Bearer token AND session auth
   * This allows the frontend to work with either authentication method
   */
  app.post("/api/rewrite", authenticateRequest, (req, res) => {
    const { url, source } = req.body;
    if (!url || !source) {
      return res.status(400).json({ error: "url and source are required" });
    }

    // Get userId from either session or token
    const userId = req.user?.id || req.oauthToken?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    getRewrittenUrl(url, userId, source)
      .then((rewrittenUrl) => res.json({ rewrittenUrl }))
      .catch((err: any) => {
        console.error("Rewrite error:", err);
        res.status(500).json({
          error: "Failed to rewrite link",
          message: err?.message || String(err),
        });
      });
  });

  app.get("/api/stats/:type", authenticateRequest, (req, res) => {
    // Get userId from either session or token
    const userId = req.user?.id || req.oauthToken?.userId;
    if (!userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const { type } = req.params;
    const { timeStart, timeEnd } = req.query as { [key: string]: string };
    if (!timeStart || !timeEnd) {
      return res.status(400).json({ error: "timeStart and timeEnd are required" });
    }

    const endpoint = `reports/${type}`;
    fetchStrackrStats(endpoint, {
      time_start: timeStart,
      time_end: timeEnd,
      time_type: "checked",
    })
      .then((data) => res.json(data))
      .catch((err) => {
        console.error(`Stats error for ${type}:`, err);
        res.status(500).json({
          error: `Failed to fetch ${type} stats`,
          message: err?.message || String(err),
        });
      });
  });

  /**
   * Protected endpoints for your local users:
   * Already using authenticateRequest middleware which handles both auth types
   */
  app.get("/api/links", authenticateRequest, async (req, res) => {
    try {
      const userId = req.user?.id || req.oauthToken?.userId;
      if (!userId) {
        return res.status(401).json({ error: "No user found in session or token" });
      }
      const userLinks = await db
        .select()
        .from(links)
        .where(eq(links.userId, userId))
        .orderBy(links.createdAt);
      res.json(userLinks);
    } catch (error) {
      console.error("Error fetching links:", error);
      res.status(500).json({ error: "Failed to fetch links" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}