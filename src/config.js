export const config = {
  appName: "EU Product Compliance",
  port: Number.parseInt(process.env.PORT || "3000", 10),
  appUrl: process.env.APP_URL || process.env.SHOPIFY_APP_URL || "",
  apiKey: process.env.SHOPIFY_API_KEY || "",
  apiSecret: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: process.env.SHOPIFY_API_VERSION || "2026-04",
  databaseUrl: process.env.DATABASE_URL || "",
  sessionSecret: process.env.SESSION_SECRET || "",
  scopes: (process.env.SCOPES || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
};

export function scopeLabel() {
  return config.scopes.length > 0 ? config.scopes.join(", ") : "Not configured";
}
