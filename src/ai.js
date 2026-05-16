import { config } from "./config.js";
import { sortFindingsBySeverity } from "./scanner.js";

const AI_SCAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["products"],
  properties: {
    products: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "summary", "riskLevel", "recommendations"],
        properties: {
          productId: {
            type: "string"
          },
          summary: {
            type: "string"
          },
          riskLevel: {
            type: "string",
            enum: ["low", "medium", "high"]
          },
          recommendations: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["severity", "code", "message", "target", "remediation", "confidence"],
              properties: {
                severity: {
                  type: "string",
                  enum: ["low", "medium", "high"]
                },
                code: {
                  type: "string"
                },
                message: {
                  type: "string"
                },
                target: {
                  type: "string"
                },
                remediation: {
                  type: "string"
                },
                confidence: {
                  type: "string",
                  enum: ["low", "medium", "high"]
                }
              }
            }
          }
        }
      }
    }
  }
};

const AI_FIX_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["fixes"],
  properties: {
    fixes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "variantId", "inventoryItemId", "field", "value", "confidence", "reason"],
        properties: {
          productId: {
            type: "string"
          },
          variantId: {
            type: "string"
          },
          inventoryItemId: {
            type: "string"
          },
          field: {
            type: "string",
            enum: ["productType", "harmonizedSystemCode"]
          },
          value: {
            type: "string"
          },
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"]
          },
          reason: {
            type: "string"
          }
        }
      }
    }
  }
};

export function aiScanningConfigured() {
  return Boolean(config.openaiApiKey);
}

export function aiProductFixesConfigured() {
  return Boolean(config.openaiApiKey && config.aiProductFixesEnabled);
}

export async function enhanceScanResultsWithAi(results) {
  if (!aiScanningConfigured() || results.length === 0) {
    return results.map((result) => withAiReview(result, "not_configured"));
  }

  try {
    const aiResponse = await requestAiReview(results);
    return mergeAiReview(results, aiResponse.products || []);
  } catch (error) {
    console.warn(`AI scan enhancement unavailable: ${error.message}`);
    return results.map((result) => withAiReview(result, "unavailable"));
  }
}

export async function suggestProductFixesWithAi(results, { timeoutMs = 12_000 } = {}) {
  if (!aiProductFixesConfigured() || results.length === 0) {
    return {
      enabled: aiProductFixesConfigured(),
      status: aiScanningConfigured() ? "disabled" : "not_configured",
      fixes: []
    };
  }

  try {
    const aiResponse = await requestAiFixSuggestions(results, { timeoutMs });

    return {
      enabled: true,
      status: "complete",
      fixes: normalizeFixSuggestions(aiResponse.fixes || [])
    };
  } catch (error) {
    console.warn(`AI product fix suggestions unavailable: ${error.message}`);
    return {
      enabled: true,
      status: "unavailable",
      fixes: []
    };
  }
}

export function summarizeAiStatus(results) {
  if (!results.length) {
    return {
      configured: aiScanningConfigured(),
      status: aiScanningConfigured() ? "complete" : "not_configured",
      reviewedProducts: 0
    };
  }

  const configured = results.some((result) => result.aiReview?.enabled);
  const reviewedProducts = results.filter((result) => result.aiReview?.status === "complete").length;
  const unavailable = results.some((result) => result.aiReview?.status === "unavailable");

  return {
    configured,
    status: unavailable ? "unavailable" : configured ? "complete" : "not_configured",
    reviewedProducts
  };
}

async function requestAiFixSuggestions(results, { timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.openaiModel,
        store: false,
        max_output_tokens: 2200,
        input: [
          {
            role: "system",
            content: [
              "You suggest Shopify product data fixes for an EU customs readiness app.",
              "Return JSON only, matching the supplied schema.",
              "Use only the product data provided.",
              "Do not suggest country of origin, barcodes, SKUs, vendors, or legal conclusions.",
              "Only suggest HS codes when the product purpose and material are clear from the supplied data.",
              "HS code values must be 6 to 13 digits."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Suggest high-confidence productType and harmonizedSystemCode fixes for missing fields.",
              guidance: [
                "Return productType fixes only for products with a missing product type.",
                "Return harmonizedSystemCode fixes only for variants with missing HS codes.",
                "Use high confidence only when the supplied title, tags, vendor, product type, and variant names make the value obvious.",
                "Return an empty fixes array when the data is insufficient."
              ],
              products: results.slice(0, 25).map(toAiProduct)
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "eu_product_compliance_ai_fixes",
            strict: true,
            schema: AI_FIX_SCHEMA
          }
        }
      })
    });

    const payload = await safeJson(response);

    if (!response.ok) {
      throw new Error(sanitizeOpenAiError(payload) || `OpenAI request failed with status ${response.status}.`);
    }

    const outputText = extractOutputText(payload);

    if (!outputText) {
      throw new Error("OpenAI response did not include JSON output.");
    }

    return JSON.parse(outputText);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAiReview(results) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.openaiApiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: config.openaiModel,
        store: false,
        max_output_tokens: 2500,
        input: [
          {
            role: "system",
            content: [
              "You are an EU customs readiness assistant for Shopify merchants.",
              "Return JSON only, matching the supplied schema.",
              "Use only the product data and deterministic findings provided.",
              "Do not provide legal advice or final customs determinations.",
              "Keep each recommendation concise and practical."
            ].join(" ")
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Review the product scan results and add advisory customs readiness recommendations.",
              guidance: [
                "Focus on HS classification clues, country-of-origin gaps, SKU/barcode hygiene, product type clarity, and documentation readiness.",
                "Avoid duplicating deterministic findings unless you can make the remediation clearer.",
                "Return no more than three recommendations per product."
              ],
              products: results.slice(0, 25).map(toAiProduct)
            })
          }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "eu_product_compliance_ai_scan",
            strict: true,
            schema: AI_SCAN_SCHEMA
          }
        }
      })
    });

    const payload = await safeJson(response);

    if (!response.ok) {
      throw new Error(sanitizeOpenAiError(payload) || `OpenAI request failed with status ${response.status}.`);
    }

    const outputText = extractOutputText(payload);

    if (!outputText) {
      throw new Error("OpenAI response did not include JSON output.");
    }

    return JSON.parse(outputText);
  } finally {
    clearTimeout(timeout);
  }
}

function toAiProduct(result) {
  const product = result.product;

  return {
    productId: product.id,
    title: product.title,
    handle: product.handle,
    vendor: product.vendor,
    productType: product.productType,
    tags: (product.tags || []).slice(0, 12),
    status: result.status,
    score: result.score,
    findings: result.findings.slice(0, 12).map((finding) => ({
      severity: finding.severity,
      code: finding.code,
      message: finding.message,
      remediation: finding.remediation
    })),
    variants: (product.variants || []).slice(0, 12).map((variant) => ({
      id: variant.id,
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      hsCode: variant.inventoryItem?.harmonizedSystemCode || "",
      countryOfOrigin: variant.inventoryItem?.countryCodeOfOrigin || "",
      requiresShipping: variant.inventoryItem?.requiresShipping !== false
    }))
  };
}

function normalizeFixSuggestions(fixes) {
  return (Array.isArray(fixes) ? fixes : []).map((fix) => {
    const field = cleanText(fix.field);
    const value = normalizeFixValue(field, fix.value);

    return {
      productId: cleanText(fix.productId),
      variantId: cleanText(fix.variantId),
      inventoryItemId: cleanText(fix.inventoryItemId),
      field,
      value,
      confidence: normalizeConfidence(fix.confidence),
      reason: cleanText(fix.reason)
    };
  }).filter((fix) => fix.productId && fix.field && fix.value);
}

function normalizeFixValue(field, value) {
  if (field === "harmonizedSystemCode") {
    const hsCode = cleanText(value).replace(/\D/g, "");
    return hsCode.length >= 6 && hsCode.length <= 13 ? hsCode : "";
  }

  if (field === "productType") {
    return cleanText(value);
  }

  return "";
}

function mergeAiReview(results, reviews) {
  const byProductId = new Map(reviews.map((review) => [review.productId, review]));

  return results.map((result) => {
    const review = byProductId.get(result.product.id);

    if (!review) {
      return withAiReview(result, "complete");
    }

    const aiFindings = normalizeRecommendations(review, result);

    return {
      ...result,
      findings: sortFindingsBySeverity([...result.findings, ...aiFindings]),
      aiReview: {
        enabled: true,
        status: "complete",
        summary: cleanText(review.summary),
        riskLevel: normalizeRisk(review.riskLevel),
        recommendations: aiFindings.length
      }
    };
  });
}

function normalizeRecommendations(review, result) {
  const recommendations = Array.isArray(review.recommendations) ? review.recommendations : [];

  return recommendations.slice(0, 3).map((recommendation, index) => ({
    source: "ai",
    severity: normalizeSeverity(recommendation.severity),
    code: normalizeCode(recommendation.code || `ai_recommendation_${index + 1}`),
    message: cleanText(recommendation.message),
    target: cleanText(recommendation.target) || result.product.id,
    remediation: cleanText(recommendation.remediation),
    confidence: normalizeConfidence(recommendation.confidence)
  })).filter((finding) => finding.message && finding.remediation);
}

function withAiReview(result, status) {
  return {
    ...result,
    aiReview: {
      enabled: aiScanningConfigured(),
      status,
      summary: "",
      riskLevel: "",
      recommendations: 0
    }
  };
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function extractOutputText(payload) {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }

  const chunks = [];

  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join("");
}

function sanitizeOpenAiError(payload) {
  if (!payload || typeof payload !== "object") {
    return "";
  }

  return payload.error?.message || payload.message || "";
}

function normalizeSeverity(value) {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

function normalizeRisk(value) {
  return ["low", "medium", "high"].includes(value) ? value : "";
}

function normalizeConfidence(value) {
  return ["low", "medium", "high"].includes(value) ? value : "low";
}

function normalizeCode(value) {
  return String(value || "ai_recommendation")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "ai_recommendation";
}

function cleanText(value) {
  return String(value || "").trim().slice(0, 500);
}
