import type { NextConfig } from "next";

/**
 * Запросы к бэкенду идут через собственный адрес фронта.
 *
 * Без этого браузер обращался бы на другой порт, а значит понадобились
 * бы CORS и cookie, летающие между источниками. Проксирование убирает
 * оба вопроса разом: для браузера всё лежит на одном адресе, cookie
 * остаётся своей, и в бою ничего менять не нужно.
 */
const API = process.env.API_URL ?? "http://127.0.0.1:8420";

const config: NextConfig = {
  devIndicators: false,
  deploymentId: process.env.RELEASE_SHA,
  transpilePackages: ["@clipforge/assistant"],
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
  async rewrites() {
    return {beforeFiles: process.env.NODE_ENV === 'production' ? [
      {source:'/_next/static/:path*',destination:`${API}/api/web-assets/:path*`},
    ] : [], afterFiles: [
      { source: "/api/:path*", destination: `${API}/api/:path*` },
      { source: "/media/:path*", destination: `${API}/media/:path*` },
    ], fallback: []};
  },
  images: {
    // Аватарки и обложки игр приходят с CDN Twitch.
    remotePatterns: [{ protocol: "https", hostname: "static-cdn.jtvnw.net" }],
  },
};

export default config;
