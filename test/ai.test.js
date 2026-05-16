import assert from "node:assert/strict";
import test from "node:test";
import { enhanceScanResultsWithAi, summarizeAiStatus } from "../src/ai.js";

test("AI enhancement is skipped when no OpenAI key is configured", async () => {
  const results = [
    {
      product: {
        id: "gid://shopify/Product/1",
        title: "Cotton Hoodie",
        handle: "cotton-hoodie",
        variants: []
      },
      status: "blocked",
      score: 75,
      findings: [],
      scannedAt: new Date().toISOString()
    }
  ];

  const enhanced = await enhanceScanResultsWithAi(results);
  const aiStatus = summarizeAiStatus(enhanced);

  assert.equal(enhanced[0].aiReview.enabled, false);
  assert.equal(enhanced[0].aiReview.status, "not_configured");
  assert.equal(aiStatus.status, "not_configured");
  assert.equal(aiStatus.reviewedProducts, 0);
});
