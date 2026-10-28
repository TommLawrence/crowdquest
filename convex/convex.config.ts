import { defineApp } from "convex/server";
import { v } from "convex/values";

export default defineApp({
  env: {
    CONVEX_SERVICE_SECRET: v.string(),
    TWITCH_EVENTSUB_SECRET: v.string(),
  },
});
