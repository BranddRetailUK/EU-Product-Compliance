export function scanProducts(products) {
  const results = products.map((product) => scanProduct(product));
  const summary = {
    scannedProducts: results.length,
    readyProducts: results.filter((result) => result.status === "ready").length,
    needsAttentionProducts: results.filter((result) => result.status === "needs_attention").length,
    blockedProducts: results.filter((result) => result.status === "blocked").length,
    lastScanAt: new Date().toISOString()
  };

  return {
    results,
    summary
  };
}

export function scanProduct(product) {
  const findings = [];
  const variants = product.variants || [];
  const shippingVariants = variants.filter((variant) => variant.inventoryItem?.requiresShipping !== false);

  const addFinding = (severity, code, message, target, remediation) => {
    findings.push({
      severity,
      code,
      message,
      target,
      remediation
    });
  };

  if (!clean(product.vendor)) {
    addFinding(
      "low",
      "missing_vendor",
      "Product vendor is missing.",
      product.id,
      "Set the vendor so compliance reviews can identify the responsible brand or supplier."
    );
  }

  if (!clean(product.productType)) {
    addFinding(
      "medium",
      "missing_product_type",
      "Product type is missing.",
      product.id,
      "Set a product type to support product classification and rule matching."
    );
  }

  if (shippingVariants.length === 0) {
    addFinding(
      "medium",
      "no_shipping_variants",
      "No shipping-required variants were found.",
      product.id,
      "Confirm whether this product is physical and should require shipping."
    );
  }

  for (const variant of shippingVariants) {
    const label = `${product.title || "Product"} / ${variant.title || "Variant"}`;

    if (!clean(variant.sku)) {
      addFinding(
        "medium",
        "missing_sku",
        `${label} is missing a SKU.`,
        variant.id,
        "Add a SKU so warehouse, customs, and compliance records can match the variant."
      );
    }

    if (!clean(variant.inventoryItem?.harmonizedSystemCode)) {
      addFinding(
        "high",
        "missing_hs_code",
        `${label} is missing a harmonized system code.`,
        variant.inventoryItem?.id || variant.id,
        "Set the HS code on the variant inventory item before selling cross-border."
      );
    }

    if (!clean(variant.inventoryItem?.countryCodeOfOrigin)) {
      addFinding(
        "high",
        "missing_country_of_origin",
        `${label} is missing country of origin.`,
        variant.inventoryItem?.id || variant.id,
        "Set country of origin on the variant inventory item before selling cross-border."
      );
    }

    if (!clean(variant.barcode)) {
      addFinding(
        "low",
        "missing_barcode",
        `${label} is missing a barcode.`,
        variant.id,
        "Add barcode data when available to improve product traceability."
      );
    }
  }

  const score = scoreFindings(findings);
  const hasHighFinding = findings.some((finding) => finding.severity === "high");
  const hasMediumFinding = findings.some((finding) => finding.severity === "medium");
  const status = hasHighFinding ? "blocked" : hasMediumFinding || findings.length > 0 ? "needs_attention" : "ready";

  return {
    product,
    status,
    score,
    findings,
    scannedAt: new Date().toISOString()
  };
}

export function compactProduct(product) {
  const variants = product.variants?.nodes || product.variants || [];
  const metafields = product.metafields?.nodes || product.metafields || [];

  return {
    id: product.id,
    title: product.title || "",
    handle: product.handle || "",
    status: product.status || "",
    vendor: product.vendor || "",
    productType: product.productType || "",
    tags: product.tags || [],
    totalInventory: product.totalInventory ?? null,
    updatedAt: product.updatedAt || null,
    variants: variants.map((variant) => ({
      id: variant.id,
      title: variant.title || "",
      sku: variant.sku || "",
      barcode: variant.barcode || "",
      inventoryItem: variant.inventoryItem
        ? {
            id: variant.inventoryItem.id,
            tracked: variant.inventoryItem.tracked,
            requiresShipping: variant.inventoryItem.requiresShipping,
            harmonizedSystemCode: variant.inventoryItem.harmonizedSystemCode || "",
            countryCodeOfOrigin: variant.inventoryItem.countryCodeOfOrigin || ""
          }
        : null
    })),
    metafields: metafields.map((metafield) => ({
      namespace: metafield.namespace,
      key: metafield.key,
      type: metafield.type,
      value: metafield.value,
      updatedAt: metafield.updatedAt
    }))
  };
}

function clean(value) {
  return String(value || "").trim();
}

function scoreFindings(findings) {
  const penalty = findings.reduce((total, finding) => {
    if (finding.severity === "high") {
      return total + 25;
    }

    if (finding.severity === "medium") {
      return total + 12;
    }

    return total + 5;
  }, 0);

  return Math.max(0, 100 - penalty);
}
