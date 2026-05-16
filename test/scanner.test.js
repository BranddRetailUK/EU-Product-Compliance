import assert from "node:assert/strict";
import test from "node:test";
import { scanProduct } from "../src/scanner.js";

test("scanner blocks shipping variants without HS code and country of origin", () => {
  const result = scanProduct({
    id: "gid://shopify/Product/1",
    title: "Cotton Hoodie",
    handle: "cotton-hoodie",
    vendor: "Brandd",
    productType: "Hoodies",
    variants: [
      {
        id: "gid://shopify/ProductVariant/1",
        title: "Small",
        sku: "HD-S",
        barcode: "123",
        requiresShipping: true,
        inventoryItem: {
          id: "gid://shopify/InventoryItem/1",
          harmonizedSystemCode: "",
          countryCodeOfOrigin: ""
        }
      }
    ]
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.findings.some((finding) => finding.code === "missing_hs_code"), true);
  assert.equal(result.findings.some((finding) => finding.code === "missing_country_of_origin"), true);
  assert.equal(result.score, 50);
});

test("scanner marks fully populated physical products as ready", () => {
  const result = scanProduct({
    id: "gid://shopify/Product/2",
    title: "Canvas Tote",
    handle: "canvas-tote",
    vendor: "Brandd",
    productType: "Bags",
    variants: [
      {
        id: "gid://shopify/ProductVariant/2",
        title: "Default",
        sku: "TOTE-1",
        barcode: "456",
        requiresShipping: true,
        inventoryItem: {
          id: "gid://shopify/InventoryItem/2",
          harmonizedSystemCode: "420292",
          countryCodeOfOrigin: "GB"
        }
      }
    ]
  });

  assert.equal(result.status, "ready");
  assert.equal(result.score, 100);
  assert.deepEqual(result.findings, []);
});
