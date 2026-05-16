import assert from "node:assert/strict";
import test from "node:test";
import { buildProductFixPlan } from "../src/fixes.js";

test("builds real product and inventory item fixes from configured defaults", () => {
  const plan = buildProductFixPlan([
    {
      product: {
        id: "gid://shopify/Product/1",
        title: "Cotton Hoodie",
        handle: "cotton-hoodie",
        vendor: "",
        productType: "",
        variants: [
          {
            id: "gid://shopify/ProductVariant/11",
            title: "Black / Small",
            sku: "",
            barcode: "",
            inventoryItem: {
              id: "gid://shopify/InventoryItem/111",
              requiresShipping: true,
              harmonizedSystemCode: "",
              countryCodeOfOrigin: ""
            }
          }
        ]
      },
      findings: []
    }
  ], {
    defaultProductVendor: "Brandd",
    defaultProductType: "Hoodies",
    defaultCountryOfOrigin: "gb"
  });

  assert.deepEqual(plan.productUpdates, [
    {
      id: "gid://shopify/Product/1",
      vendor: "Brandd",
      productType: "Hoodies"
    }
  ]);
  assert.deepEqual(plan.inventoryItemUpdates, [
    {
      id: "gid://shopify/InventoryItem/111",
      input: {
        sku: "COTTON-HOODIE-BLACK-SMALL-11",
        countryCodeOfOrigin: "GB"
      },
      productId: "gid://shopify/Product/1",
      variantId: "gid://shopify/ProductVariant/11"
    }
  ]);
  assert.equal(plan.appliedFixes.length, 4);
  assert.equal(plan.skippedFixes.some((fix) => fix.field === "barcode"), true);
  assert.equal(plan.skippedFixes.some((fix) => fix.field === "harmonizedSystemCode"), true);
  assert.deepEqual(plan.productIds, ["gid://shopify/Product/1"]);
});

test("applies high-confidence AI HS code candidates", () => {
  const plan = buildProductFixPlan([
    {
      product: {
        id: "gid://shopify/Product/2",
        title: "Ceramic Mug",
        handle: "ceramic-mug",
        vendor: "Brandd",
        productType: "Mugs",
        variants: [
          {
            id: "gid://shopify/ProductVariant/22",
            title: "White",
            sku: "MUG-WHITE",
            barcode: "123",
            inventoryItem: {
              id: "gid://shopify/InventoryItem/222",
              requiresShipping: true,
              harmonizedSystemCode: "",
              countryCodeOfOrigin: "GB"
            }
          }
        ]
      },
      findings: []
    }
  ], {
    aiFixes: [
      {
        productId: "gid://shopify/Product/2",
        variantId: "gid://shopify/ProductVariant/22",
        inventoryItemId: "gid://shopify/InventoryItem/222",
        field: "harmonizedSystemCode",
        value: "691200",
        confidence: "high"
      }
    ]
  });

  assert.deepEqual(plan.inventoryItemUpdates, [
    {
      id: "gid://shopify/InventoryItem/222",
      input: {
        harmonizedSystemCode: "691200"
      },
      productId: "gid://shopify/Product/2",
      variantId: "gid://shopify/ProductVariant/22"
    }
  ]);
  assert.equal(plan.appliedFixes[0].field, "harmonizedSystemCode");
  assert.equal(plan.appliedFixes[0].source, "ai");
});

test("ignores low-confidence or invalid AI fix candidates", () => {
  const plan = buildProductFixPlan([
    {
      product: {
        id: "gid://shopify/Product/3",
        title: "Phone Case",
        handle: "phone-case",
        vendor: "Brandd",
        productType: "Accessories",
        variants: [
          {
            id: "gid://shopify/ProductVariant/33",
            title: "iPhone 15",
            sku: "CASE-15",
            barcode: "456",
            inventoryItem: {
              id: "gid://shopify/InventoryItem/333",
              requiresShipping: true,
              harmonizedSystemCode: "",
              countryCodeOfOrigin: "GB"
            }
          }
        ]
      },
      findings: []
    }
  ], {
    aiFixes: [
      {
        productId: "gid://shopify/Product/3",
        variantId: "gid://shopify/ProductVariant/33",
        field: "harmonizedSystemCode",
        value: "abc",
        confidence: "high"
      },
      {
        productId: "gid://shopify/Product/3",
        variantId: "gid://shopify/ProductVariant/33",
        field: "harmonizedSystemCode",
        value: "392690",
        confidence: "medium"
      }
    ]
  });

  assert.deepEqual(plan.inventoryItemUpdates, []);
  assert.equal(plan.skippedFixes.some((fix) => fix.field === "harmonizedSystemCode"), true);
});
