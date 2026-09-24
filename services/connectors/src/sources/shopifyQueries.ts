/**
 * Admin GraphQL queries. Page sizes keep each query's *requested* cost under
 * Shopify's 1,000-point single-query limit (cost ≈ page size × nested page
 * sizes). The orders page size is a variable so the connector can shrink it
 * if Shopify reports the query as too expensive.
 */
const MONEY = "shopMoney { amount currencyCode }";

export const ORDER_FIELDS = `
  id
  name
  createdAt
  processedAt
  updatedAt
  cancelledAt
  test
  sourceName
  displayFinancialStatus
  channelInformation { channelDefinition { handle channelName } }
  retailLocation { id name }
  subtotalPriceSet { ${MONEY} }
  totalDiscountsSet { ${MONEY} }
  totalTaxSet { ${MONEY} }
  totalShippingPriceSet { ${MONEY} }
  totalPriceSet { ${MONEY} }
  totalRefundedSet { ${MONEY} }
  totalTipReceivedSet { ${MONEY} }
  lineItems(first: 30) {
    pageInfo { hasNextPage endCursor }
    nodes { ...LineItemFields }
  }
  refunds(first: 10) { id createdAt totalRefundedSet { ${MONEY} } }
  transactions(first: 10) {
    id kind status processedAt
    amountSet { ${MONEY} }
    fees { amount { amount currencyCode } }
  }
`;

export const LINE_ITEM_FRAGMENT = `
fragment LineItemFields on LineItem {
  id
  name
  sku
  vendor
  quantity
  currentQuantity
  originalUnitPriceSet { ${MONEY} }
  originalTotalSet { ${MONEY} }
  totalDiscountSet { ${MONEY} }
  discountedTotalSet { ${MONEY} }
  product { id title productType }
  variant { id title }
}`;

export const ORDERS_QUERY = `
query Orders($first: Int!, $after: String, $query: String) {
  orders(first: $first, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { ${ORDER_FIELDS} }
  }
}
${LINE_ITEM_FRAGMENT}`;

export const ORDER_QUERY = `
query Order($id: ID!) {
  order(id: $id) { ${ORDER_FIELDS} }
}
${LINE_ITEM_FRAGMENT}`;

/** Remaining line items for orders with more than one page of them. */
export const ORDER_LINE_ITEMS_QUERY = `
query OrderLineItems($id: ID!, $after: String) {
  order(id: $id) {
    lineItems(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ...LineItemFields }
    }
  }
}
${LINE_ITEM_FRAGMENT}`;

const PRODUCT_FIELDS = `
  id
  title
  productType
  vendor
  status
  createdAt
  updatedAt
  variants(first: 50) { nodes { id title sku price inventoryItem { id } } }
`;

export const PRODUCTS_QUERY = `
query Products($after: String, $query: String) {
  products(first: 8, after: $after, sortKey: UPDATED_AT, query: $query) {
    pageInfo { hasNextPage endCursor }
    nodes { ${PRODUCT_FIELDS} }
  }
}`;

export const PRODUCT_QUERY = `
query Product($id: ID!) {
  product(id: $id) { ${PRODUCT_FIELDS} }
}`;

export const INVENTORY_QUERY = `
query Inventory($after: String) {
  inventoryItems(first: 25, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      sku
      tracked
      variant { id title product { id title } }
      inventoryLevels(first: 10) {
        nodes {
          location { id name }
          quantities(names: ["available", "on_hand"]) { name quantity }
        }
      }
    }
  }
}`;

export const WEBHOOK_SUBSCRIPTIONS_QUERY = `
query Webhooks($after: String) {
  webhookSubscriptions(first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id topic uri }
  }
}`;

export const WEBHOOK_CREATE_MUTATION = `
mutation CreateWebhook($topic: WebhookSubscriptionTopic!, $uri: String!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) {
    webhookSubscription { id topic uri }
    userErrors { field message }
  }
}`;
