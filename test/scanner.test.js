import assert from "node:assert/strict";
import test from "node:test";
import { compactProduct, scanProduct } from "../src/scanner.js";

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
        inventoryItem: {
          id: "gid://shopify/InventoryItem/1",
          requiresShipping: true,
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
        inventoryItem: {
          id: "gid://shopify/InventoryItem/2",
          requiresShipping: true,
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

test("scanner orders findings by high, medium, then low priority", () => {
  const result = scanProduct({
    id: "gid://shopify/Product/3",
    title: "Sticker Pack",
    handle: "sticker-pack",
    vendor: "",
    productType: "",
    variants: [
      {
        id: "gid://shopify/ProductVariant/3",
        title: "Default",
        sku: "",
        barcode: "",
        inventoryItem: {
          id: "gid://shopify/InventoryItem/3",
          requiresShipping: true,
          harmonizedSystemCode: "",
          countryCodeOfOrigin: ""
        }
      }
    ]
  });

  assert.deepEqual(result.findings.map((finding) => finding.severity), [
    "high",
    "high",
    "medium",
    "medium",
    "low",
    "low"
  ]);
});

test("compact product includes the first product media image", () => {
  const product = compactProduct({
    id: "gid://shopify/Product/4",
    title: "Beanie",
    media: {
      nodes: [
        {
          alt: "Folded black beanie",
          preview: {
            image: {
              url: "https://cdn.shopify.com/beanie.jpg",
              altText: "",
              width: 800,
              height: 800
            }
          }
        }
      ]
    },
    variants: {
      nodes: []
    },
    metafields: {
      nodes: []
    }
  });

  assert.deepEqual(product.image, {
    url: "https://cdn.shopify.com/beanie.jpg",
    altText: "Folded black beanie",
    width: 800,
    height: 800
  });
});
