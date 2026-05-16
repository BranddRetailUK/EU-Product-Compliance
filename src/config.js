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
  aiProductFixesEnabled: process.env.AI_PRODUCT_FIXES_ENABLED === "true",
  defaultProductVendor: process.env.DEFAULT_PRODUCT_VENDOR || "",
  defaultProductType: process.env.DEFAULT_PRODUCT_TYPE || "",
  defaultCountryOfOrigin: process.env.DEFAULT_COUNTRY_OF_ORIGIN || "",
  freeFixProductLimit: Number.parseInt(process.env.FREE_FIX_PRODUCT_LIMIT || "10", 10),
  devBypassBillingGates: process.env.DEV_BYPASS_BILLING_GATES === "true",
  scopes: (process.env.SCOPES || "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean)
};
