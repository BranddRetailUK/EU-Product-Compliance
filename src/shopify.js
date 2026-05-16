import { config } from "./config.js";
import {
  getShopSession,
  markShopSeen,
  upsertShopSession
} from "./database.js";
import { AuthError, ConfigurationError, getBearerToken, verifyShopifySessionToken } from "./security.js";
import { compactProduct } from "./scanner.js";

export class ShopifyApiError extends Error {
  constructor(message, details = undefined, statusCode = 502) {
    super(message);
    this.name = "ShopifyApiError";
    this.details = details;
    this.statusCode = statusCode;
  }
}

export async function authenticateAdminRequest(req) {
  const sessionToken = getBearerToken(req);

  if (!sessionToken) {
    throw new AuthError("Missing Shopify session token.");
  }

  const context = verifyShopifySessionToken(sessionToken);
  const session = await ensureOfflineSession(context.shop, sessionToken);

  await markShopSeen(context.shop);

  return {
    ...context,
    session
  };
}

export async function ensureOfflineSession(shop, sessionToken) {
  const existingSession = await getShopSession(shop);

  if (existingSession?.accessToken && hasConfiguredScopes(existingSession.scopes)) {
    return existingSession;
  }

  const tokenResponse = await exchangeSessionTokenForOfflineToken(shop, sessionToken);

  return upsertShopSession({
    shop,
    accessToken: tokenResponse.access_token,
    scope: tokenResponse.scope || "",
    accessMode: "offline"
  });
}

function hasConfiguredScopes(grantedScopes) {
  if (config.scopes.length === 0) {
    return true;
  }

  const granted = new Set(grantedScopes || []);
  return config.scopes.every((scope) => granted.has(scope));
}

export async function exchangeSessionTokenForOfflineToken(shop, sessionToken) {
  if (!config.apiKey || !config.apiSecret) {
    throw new ConfigurationError("Shopify API credentials are not configured.");
  }

  const body = new URLSearchParams({
    client_id: config.apiKey,
    client_secret: config.apiSecret,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: sessionToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type: "urn:shopify:params:oauth:token-type:offline-access-token"
  });

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });

  const payload = await safeJson(response);

  if (!response.ok || !payload.access_token) {
    throw new ShopifyApiError("Shopify token exchange failed.", sanitizeShopifyError(payload), response.status);
  }

  return payload;
}

export async function fetchProducts(session, { first = 25, after = null } = {}) {
  const data = await shopifyGraphql(session, PRODUCTS_QUERY, {
    first: Math.min(Math.max(Number(first) || 25, 1), 50),
    after
  });

  const connection = data.products;

  return {
    products: connection.nodes.map(compactProduct),
    pageInfo: connection.pageInfo
  };
}

export async function fetchProductsByIds(session, productIds) {
  const ids = [...new Set(productIds)].filter((id) => /^gid:\/\/shopify\/Product\/\d+$/.test(id));

  if (ids.length === 0) {
    return [];
  }

  const data = await shopifyGraphql(session, PRODUCTS_BY_IDS_QUERY, {
    ids: ids.slice(0, 50)
  });

  return data.nodes.filter(Boolean).map(compactProduct);
}

export async function writeComplianceMetafields(session, scanResults) {
  const metafields = scanResults.flatMap((result) => [
    {
      ownerId: result.product.id,
      namespace: "eu_product_compliance",
      key: "readiness_status",
      type: "single_line_text_field",
      value: result.status
    },
    {
      ownerId: result.product.id,
      namespace: "eu_product_compliance",
      key: "readiness_score",
      type: "number_integer",
      value: String(result.score)
    },
    {
      ownerId: result.product.id,
      namespace: "eu_product_compliance",
      key: "last_scan_at",
      type: "date_time",
      value: result.scannedAt
    },
    {
      ownerId: result.product.id,
      namespace: "eu_product_compliance",
      key: "findings_json",
      type: "json",
      value: JSON.stringify(result.findings)
    }
  ]);

  const batches = [];

  for (let index = 0; index < metafields.length; index += 25) {
    batches.push(metafields.slice(index, index + 25));
  }

  const userErrors = [];

  for (const batch of batches) {
    const data = await shopifyGraphql(session, METAFIELDS_SET_MUTATION, {
      metafields: batch
    });

    userErrors.push(...(data.metafieldsSet?.userErrors || []));
  }

  if (userErrors.length > 0) {
    throw new ShopifyApiError("Shopify rejected one or more compliance metafield writes.", userErrors, 422);
  }

  return {
    metafieldsWritten: metafields.length
  };
}

export async function applyProductFixes(session, fixPlan) {
  const result = {
    productUpdatesApplied: 0,
    inventoryItemUpdatesApplied: 0,
    appliedFixes: fixPlan.appliedFixes || [],
    skippedFixes: fixPlan.skippedFixes || []
  };
  const userErrors = [];

  for (const product of fixPlan.productUpdates || []) {
    const data = await shopifyGraphql(session, PRODUCT_UPDATE_MUTATION, {
      product
    });

    userErrors.push(...(data.productUpdate?.userErrors || []));

    if ((data.productUpdate?.userErrors || []).length === 0) {
      result.productUpdatesApplied += 1;
    }
  }

  for (const update of fixPlan.inventoryItemUpdates || []) {
    const data = await shopifyGraphql(session, INVENTORY_ITEM_UPDATE_MUTATION, {
      id: update.id,
      input: update.input
    });

    userErrors.push(...(data.inventoryItemUpdate?.userErrors || []));

    if ((data.inventoryItemUpdate?.userErrors || []).length === 0) {
      result.inventoryItemUpdatesApplied += 1;
    }
  }

  if (userErrors.length > 0) {
    throw new ShopifyApiError("Shopify rejected one or more product fixes.", userErrors, 422);
  }

  return result;
}

async function shopifyGraphql(session, query, variables = {}) {
  const response = await fetch(`https://${session.shop}/admin/api/${config.apiVersion}/graphql.json`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-shopify-access-token": session.accessToken
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  const payload = await safeJson(response);

  if (!response.ok || payload.errors) {
    throw new ShopifyApiError("Shopify Admin API request failed.", sanitizeShopifyError(payload), response.status);
  }

  return payload.data;
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function sanitizeShopifyError(payload) {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const clone = { ...payload };
  delete clone.access_token;
  delete clone.refresh_token;
  return clone;
}

const PRODUCT_FIELDS_FRAGMENT = `
  fragment ProductComplianceFields on Product {
    id
    title
    handle
    status
    vendor
    productType
    tags
    totalInventory
    updatedAt
    media(first: 1, sortKey: POSITION) {
      nodes {
        alt
        preview {
          image {
            url
            altText
            width
            height
          }
        }
        ... on MediaImage {
          image {
            url
            altText
            width
            height
          }
        }
      }
    }
    variants(first: 50) {
      nodes {
        id
        title
        sku
        barcode
        inventoryItem {
          id
          tracked
          requiresShipping
          harmonizedSystemCode
          countryCodeOfOrigin
        }
      }
    }
    metafields(namespace: "eu_product_compliance", first: 10) {
      nodes {
        namespace
        key
        type
        value
        updatedAt
      }
    }
  }
`;

const PRODUCTS_QUERY = `
  ${PRODUCT_FIELDS_FRAGMENT}
  query ProductsForCompliance($first: Int!, $after: String) {
    products(first: $first, after: $after, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        ...ProductComplianceFields
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PRODUCTS_BY_IDS_QUERY = `
  ${PRODUCT_FIELDS_FRAGMENT}
  query ProductsByIds($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Product {
        ...ProductComplianceFields
      }
    }
  }
`;

const METAFIELDS_SET_MUTATION = `
  mutation SetComplianceMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

const PRODUCT_UPDATE_MUTATION = `
  mutation UpdateProductForCompliance($product: ProductUpdateInput!) {
    productUpdate(product: $product) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const INVENTORY_ITEM_UPDATE_MUTATION = `
  mutation UpdateInventoryItemForCompliance($id: ID!, $input: InventoryItemInput!) {
    inventoryItemUpdate(id: $id, input: $input) {
      inventoryItem {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;
