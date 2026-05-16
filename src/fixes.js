const DEFAULT_TITLE = "Default Title";

export function buildProductFixPlan(scanResults, options = {}) {
  const settings = normalizeOptions(options);
  const productUpdates = [];
  const inventoryItemUpdates = [];
  const appliedFixes = [];
  const skippedFixes = [];
  const plannedProductIds = new Set();
  const usedSkus = new Set();

  for (const result of scanResults || []) {
    const product = result.product;

    if (!product?.id) {
      continue;
    }

    const productInput = {
      id: product.id
    };

    if (!clean(product.vendor)) {
      if (settings.defaultProductVendor) {
        productInput.vendor = settings.defaultProductVendor;
        plannedProductIds.add(product.id);
        appliedFixes.push(fixRecord(product, null, "vendor", settings.defaultProductVendor, "default"));
      } else {
        skippedFixes.push(skipRecord(product, null, "vendor", "missing_default_vendor"));
      }
    }

    if (!clean(product.productType)) {
      const aiProductType = findAiFix(settings.aiFixes, product.id, null, "productType");
      const productType = settings.defaultProductType || aiProductType?.value || "";
      const source = settings.defaultProductType ? "default" : "ai";

      if (productType) {
        productInput.productType = productType;
        plannedProductIds.add(product.id);
        appliedFixes.push(fixRecord(product, null, "productType", productType, source));
      } else {
        skippedFixes.push(skipRecord(product, null, "productType", "missing_default_or_ai_product_type"));
      }
    }

    if (Object.keys(productInput).length > 1) {
      productUpdates.push(productInput);
    }

    for (const variant of product.variants || []) {
      if (variant.inventoryItem?.requiresShipping === false) {
        continue;
      }

      const inventoryItemId = variant.inventoryItem?.id;
      const inventoryInput = {};

      if (!clean(variant.sku)) {
        const sku = generateSku(product, variant, usedSkus);

        if (inventoryItemId && sku) {
          inventoryInput.sku = sku;
          plannedProductIds.add(product.id);
          appliedFixes.push(fixRecord(product, variant, "sku", sku, "generated"));
        } else {
          skippedFixes.push(skipRecord(product, variant, "sku", "missing_inventory_item"));
        }
      }

      if (!clean(variant.inventoryItem?.countryCodeOfOrigin)) {
        if (inventoryItemId && settings.defaultCountryOfOrigin) {
          inventoryInput.countryCodeOfOrigin = settings.defaultCountryOfOrigin;
          plannedProductIds.add(product.id);
          appliedFixes.push(fixRecord(product, variant, "countryCodeOfOrigin", settings.defaultCountryOfOrigin, "default"));
        } else {
          skippedFixes.push(skipRecord(product, variant, "countryCodeOfOrigin", "missing_default_country_of_origin"));
        }
      }

      if (!clean(variant.inventoryItem?.harmonizedSystemCode)) {
        const aiHsCode = findAiFix(settings.aiFixes, product.id, variant.id, "harmonizedSystemCode");

        if (inventoryItemId && aiHsCode?.value) {
          inventoryInput.harmonizedSystemCode = aiHsCode.value;
          plannedProductIds.add(product.id);
          appliedFixes.push(fixRecord(product, variant, "harmonizedSystemCode", aiHsCode.value, "ai"));
        } else {
          skippedFixes.push(skipRecord(product, variant, "harmonizedSystemCode", "missing_ai_hs_code_candidate"));
        }
      }

      if (!clean(variant.barcode)) {
        skippedFixes.push(skipRecord(product, variant, "barcode", "barcode_not_auto_generated"));
      }

      if (Object.keys(inventoryInput).length > 0) {
        inventoryItemUpdates.push({
          id: inventoryItemId,
          input: inventoryInput,
          productId: product.id,
          variantId: variant.id
        });
      }
    }
  }

  return {
    productUpdates,
    inventoryItemUpdates,
    appliedFixes,
    skippedFixes,
    productIds: [...plannedProductIds]
  };
}

function normalizeOptions(options) {
  return {
    defaultProductVendor: clean(options.defaultProductVendor).slice(0, 255),
    defaultProductType: clean(options.defaultProductType).slice(0, 255),
    defaultCountryOfOrigin: normalizeCountryCode(options.defaultCountryOfOrigin),
    aiFixes: normalizeAiFixes(options.aiFixes || [])
  };
}

function normalizeAiFixes(aiFixes) {
  return (aiFixes || []).map((fix) => {
    const field = clean(fix.field);
    const value = normalizeAiFixValue(field, fix.value);

    return {
      productId: clean(fix.productId),
      variantId: clean(fix.variantId),
      inventoryItemId: clean(fix.inventoryItemId),
      field,
      value,
      confidence: clean(fix.confidence)
    };
  }).filter((fix) => fix.productId && fix.field && fix.value && fix.confidence === "high");
}

function normalizeAiFixValue(field, value) {
  if (field === "harmonizedSystemCode") {
    const hsCode = clean(value).replace(/\D/g, "");
    return hsCode.length >= 6 && hsCode.length <= 13 ? hsCode : "";
  }

  if (field === "productType") {
    return clean(value).slice(0, 255);
  }

  return "";
}

function findAiFix(aiFixes, productId, variantId, field) {
  return aiFixes.find((fix) => {
    if (fix.productId !== productId || fix.field !== field) {
      return false;
    }

    return !variantId || fix.variantId === variantId;
  });
}

function generateSku(product, variant, usedSkus) {
  const productPart = slugPart(product.handle || product.title || "product");
  const variantPart = variant.title && variant.title !== DEFAULT_TITLE ? slugPart(variant.title) : "";
  const idPart = idTail(variant.id);
  const parts = [productPart, variantPart, idPart].filter(Boolean);
  const base = parts.join("-").slice(0, 64) || `SKU-${idPart || Date.now()}`;
  let sku = base;
  let counter = 2;

  while (usedSkus.has(sku)) {
    const suffix = `-${counter}`;
    sku = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    counter += 1;
  }

  usedSkus.add(sku);
  return sku;
}

function fixRecord(product, variant, field, value, source) {
  return {
    productId: product.id,
    productTitle: product.title || "",
    variantId: variant?.id || "",
    variantTitle: variant?.title || "",
    field,
    value,
    source
  };
}

function skipRecord(product, variant, field, reason) {
  return {
    productId: product.id,
    productTitle: product.title || "",
    variantId: variant?.id || "",
    variantTitle: variant?.title || "",
    field,
    reason
  };
}

function normalizeCountryCode(value) {
  const countryCode = clean(value).toUpperCase();
  return /^[A-Z]{2}$/.test(countryCode) ? countryCode : "";
}

function slugPart(value) {
  return clean(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

function idTail(value) {
  const match = clean(value).match(/(\d+)$/);
  return match ? match[1].slice(-6) : "";
}

function clean(value) {
  return String(value || "").trim();
}
