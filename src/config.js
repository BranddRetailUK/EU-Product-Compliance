export const config = {
  appName: "EU Product Compliance",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  apiKey: process.env.SHOPIFY_API_KEY || "",
  apiSecret: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-04",
  databaseUrl: process.env.DATABASE_URL || "",
  sessionSecret: process.env.SESSION_SECRET || "",
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  scopes: (process.env.SCOPES || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
};
