import { createHash } from 'node:crypto';
import axios from 'axios';
import IORedis from 'ioredis';
import { AppDataSource } from '../config/database';

type CatalogRow = {
  product_id: string;
  product_name: string;
  description: string | null;
  brand_name: string | null;
  category_name: string | null;
  updated_at: Date;
  variant_id: string;
  variant_name: string | null;
  seller_sku: string;
  variant_attributes: unknown;
  price: string;
  currency: string;
  available_stock: number;
};

export type ShopCatalogVariant = {
  id: string;
  name: string | null;
  sku: string;
  color: string | null;
  size: string | null;
  price: string;
  currency: string;
  availableStock: number;
};

export type ShopCatalogProduct = {
  id: string;
  name: string;
  description: string;
  brand: string | null;
  category: string | null;
  updatedAt: string;
  variants: ShopCatalogVariant[];
};

export type ShopCatalogSnapshot = {
  tenantId: string;
  marketplaceAccountId: string;
  version: string;
  builtAt: string;
  products: ShopCatalogProduct[];
};

export type ShopKnowledgeStatus = {
  marketplaceAccountId: string;
  status: string;
  catalogVersion: string | null;
  productCount: number;
  variantCount: number;
  missingColorCount: number;
  missingSizeCount: number;
  indexedPoints: number;
  cacheStatus: string;
  vectorStatus: string;
  lastBuiltAt: Date | null;
  lastIndexedAt: Date | null;
  lastError: string | null;
};

function jsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || !value.trim()) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function normalizedAttributeKey(value: unknown) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '');
}

const ATTRIBUTE_KEYS = {
  color: new Set(['color', 'colour', 'colorfamily', 'colorname', 'mau', 'mausac']),
  size: new Set(['size', 'sizename', 'kichthuoc']),
  variantName: new Set(['variantname', 'skuname', 'tenbienthe']),
};

function textAttribute(value: unknown, key: keyof typeof ATTRIBUTE_KEYS): string | null {
  const parsed = jsonValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const result = textAttribute(item, key);
      if (result) return result;
    }
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const object = parsed as Record<string, unknown>;
  for (const [candidateKey, candidateValue] of Object.entries(object)) {
    if (!ATTRIBUTE_KEYS[key].has(normalizedAttributeKey(candidateKey))) continue;
    if (candidateValue === null || typeof candidateValue === 'object') continue;
    const result = String(candidateValue).trim();
    if (result) return result;
  }
  const declaredKey = normalizedAttributeKey(
    object.id ?? object.name ?? object.attribute_name,
  );
  if (ATTRIBUTE_KEYS[key].has(declaredKey)) {
    const result = String(
      object.value_name ?? object.value ?? object.attribute_value ?? '',
    ).trim();
    if (result) return result;
  }
  for (const nested of Object.values(object)) {
    if (!nested || typeof nested !== 'object') continue;
    const result = textAttribute(nested, key);
    if (result) return result;
  }
  return null;
}

function compactText(value: string | null, limit: number) {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function qdrantShopIsolationFilter(tenantId: string, marketplaceAccountId: string) {
  return {
    must: [
      { key: 'tenant_id', match: { value: tenantId } },
      { key: 'marketplace_account_id', match: { value: marketplaceAccountId } },
    ],
  };
}

export class ShopKnowledgeService {
  private schemaReady: Promise<void> | null = null;
  private readonly qdrant = axios.create({
    baseURL: process.env.QDRANT_URL || 'http://127.0.0.1:6333',
    timeout: Number(process.env.QDRANT_TIMEOUT_MS || 5000),
    headers: process.env.QDRANT_API_KEY
      ? { 'api-key': process.env.QDRANT_API_KEY }
      : undefined,
  });
  private readonly collection = process.env.SHOP_CATALOG_QDRANT_COLLECTION
    || 'omnichannel_shop_catalog_64_v1';
  private readonly vectorSize = 64;
  private readonly cacheTtlSeconds = Number(process.env.SHOP_KNOWLEDGE_CACHE_TTL_SECONDS || 3600);
  private readonly refreshIntervalMs = Math.max(
    60_000,
    Number(process.env.SHOP_KNOWLEDGE_REFRESH_INTERVAL_MS) || 20 * 60 * 1000,
  );
  private refreshTimer: NodeJS.Timeout | null = null;
  private automaticRefreshRunning = false;
  private redis: IORedis | null = null;

  startAutomaticRefresh() {
    if (this.refreshTimer) return;
    void this.rebuildConnectedShops();
    this.refreshTimer = setInterval(() => {
      void this.rebuildConnectedShops();
    }, this.refreshIntervalMs);
  }

  private async ensureSchema() {
    if (!this.schemaReady) {
      this.schemaReady = AppDataSource.query(`
        CREATE TABLE IF NOT EXISTS ai_shop_knowledge_status (
          tenant_id VARCHAR(36) NOT NULL,
          marketplace_account_id VARCHAR(36) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'BUILDING',
          catalog_version VARCHAR(64),
          product_count INTEGER NOT NULL DEFAULT 0,
          variant_count INTEGER NOT NULL DEFAULT 0,
          missing_color_count INTEGER NOT NULL DEFAULT 0,
          missing_size_count INTEGER NOT NULL DEFAULT 0,
          indexed_points INTEGER NOT NULL DEFAULT 0,
          cache_status VARCHAR(20) NOT NULL DEFAULT 'EMPTY',
          vector_status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
          last_built_at TIMESTAMPTZ(3),
          last_indexed_at TIMESTAMPTZ(3),
          last_error TEXT,
          created_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          PRIMARY KEY (tenant_id, marketplace_account_id),
          CONSTRAINT fk_ai_shop_knowledge_status_account
            FOREIGN KEY (marketplace_account_id, tenant_id)
            REFERENCES marketplace_accounts(id, tenant_id)
            ON UPDATE RESTRICT ON DELETE CASCADE,
          CONSTRAINT ck_ai_shop_knowledge_status_state
            CHECK (status IN ('BUILDING', 'READY', 'DEGRADED', 'FAILED'))
        )
      `).then(() => undefined).catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    await this.schemaReady;
  }

  async build(tenantId: string, marketplaceAccountId: string): Promise<ShopCatalogSnapshot> {
    await this.ensureSchema();
    await this.requireOwnedShop(tenantId, marketplaceAccountId);
    await this.markBuilding(tenantId, marketplaceAccountId);
    try {
      const rows = await this.loadCatalogRows(tenantId, marketplaceAccountId);
      const products = this.groupRows(rows);
      const builtAt = new Date().toISOString();
      const version = createHash('sha256')
        .update(JSON.stringify(products))
        .digest('hex');
      const snapshot: ShopCatalogSnapshot = {
        tenantId,
        marketplaceAccountId,
        version,
        builtAt,
        products,
      };
      const variants = products.flatMap((product) => product.variants);
      await AppDataSource.query(
        `
          INSERT INTO ai_shop_knowledge_status (
            tenant_id, marketplace_account_id, status, catalog_version,
            product_count, variant_count, missing_color_count,
            missing_size_count, cache_status, vector_status,
            last_built_at, last_error, updated_at
          ) VALUES ($1, $2, 'READY', $3, $4, $5, $6, $7,
                    'EMPTY', 'PENDING', CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP)
          ON CONFLICT (tenant_id, marketplace_account_id) DO UPDATE SET
            status = EXCLUDED.status,
            catalog_version = EXCLUDED.catalog_version,
            product_count = EXCLUDED.product_count,
            variant_count = EXCLUDED.variant_count,
            missing_color_count = EXCLUDED.missing_color_count,
            missing_size_count = EXCLUDED.missing_size_count,
            cache_status = EXCLUDED.cache_status,
            vector_status = EXCLUDED.vector_status,
            last_built_at = EXCLUDED.last_built_at,
            last_error = NULL,
            updated_at = CURRENT_TIMESTAMP
        `,
        [
          tenantId,
          marketplaceAccountId,
          version,
          products.length,
          variants.length,
          variants.filter((variant) => !variant.color).length,
          variants.filter((variant) => !variant.size).length,
        ],
      );
      try {
        await this.cacheSnapshot(snapshot);
        await AppDataSource.query(
          `UPDATE ai_shop_knowledge_status
           SET cache_status = 'READY', updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $1 AND marketplace_account_id = $2`,
          [tenantId, marketplaceAccountId],
        );
      } catch (cacheError) {
        const cacheMessage = cacheError instanceof Error
          ? cacheError.message
          : String(cacheError);
        await AppDataSource.query(
          `UPDATE ai_shop_knowledge_status
           SET status = 'DEGRADED', cache_status = 'FAILED',
               last_error = $3, updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $1 AND marketplace_account_id = $2`,
          [tenantId, marketplaceAccountId, cacheMessage.slice(0, 2000)],
        );
      }
      try {
        const indexedPoints = await this.indexSnapshot(snapshot);
        await AppDataSource.query(
          `UPDATE ai_shop_knowledge_status
           SET indexed_points = $3, vector_status = 'READY',
               last_indexed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $1 AND marketplace_account_id = $2`,
          [tenantId, marketplaceAccountId, indexedPoints],
        );
      } catch (indexError) {
        const indexMessage = indexError instanceof Error
          ? indexError.message
          : String(indexError);
        await AppDataSource.query(
          `UPDATE ai_shop_knowledge_status
           SET status = 'DEGRADED', vector_status = 'FAILED',
               last_error = $3, updated_at = CURRENT_TIMESTAMP
           WHERE tenant_id = $1 AND marketplace_account_id = $2`,
          [tenantId, marketplaceAccountId, indexMessage.slice(0, 2000)],
        );
      }
      return snapshot;
    } catch (error) {
      await this.markFailed(tenantId, marketplaceAccountId, error);
      throw error;
    }
  }

  async status(tenantId: string, marketplaceAccountId: string) {
    await this.ensureSchema();
    await this.requireOwnedShop(tenantId, marketplaceAccountId);
    const rows = await AppDataSource.query<Array<{
      marketplace_account_id: string;
      status: string;
      catalog_version: string | null;
      product_count: number;
      variant_count: number;
      missing_color_count: number;
      missing_size_count: number;
      indexed_points: number;
      cache_status: string;
      vector_status: string;
      last_built_at: Date | null;
      last_indexed_at: Date | null;
      last_error: string | null;
    }>>(
      `SELECT * FROM ai_shop_knowledge_status
       WHERE tenant_id = $1 AND marketplace_account_id = $2`,
      [tenantId, marketplaceAccountId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      marketplaceAccountId: row.marketplace_account_id,
      status: row.status,
      catalogVersion: row.catalog_version,
      productCount: Number(row.product_count),
      variantCount: Number(row.variant_count),
      missingColorCount: Number(row.missing_color_count),
      missingSizeCount: Number(row.missing_size_count),
      indexedPoints: Number(row.indexed_points),
      cacheStatus: row.cache_status,
      vectorStatus: row.vector_status,
      lastBuiltAt: row.last_built_at,
      lastIndexedAt: row.last_indexed_at,
      lastError: row.last_error,
    } satisfies ShopKnowledgeStatus;
  }

  async getOrBuild(tenantId: string, marketplaceAccountId: string) {
    const cached = await this.getCachedSnapshot(tenantId, marketplaceAccountId);
    if (cached) return cached;
    return this.build(tenantId, marketplaceAccountId);
  }

  async getCachedSnapshot(tenantId: string, marketplaceAccountId: string) {
    try {
      const redis = await this.redisClient();
      const value = await redis.get(this.cacheKey(tenantId, marketplaceAccountId));
      if (!value) return null;
      const snapshot = JSON.parse(value) as ShopCatalogSnapshot;
      if (
        snapshot.tenantId !== tenantId
        || snapshot.marketplaceAccountId !== marketplaceAccountId
        || !Array.isArray(snapshot.products)
      ) return null;
      return snapshot;
    } catch {
      return null;
    }
  }

  async close() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (!this.redis) return;
    const connection = this.redis;
    this.redis = null;
    if (connection.status === 'ready' || connection.status === 'connecting') {
      await connection.quit().catch(() => connection.disconnect());
    } else {
      connection.disconnect();
    }
  }

  async vectorSearch(
    tenantId: string,
    marketplaceAccountId: string,
    query: string,
    limit = 8,
  ): Promise<Array<{ productId: string; score: number }>> {
    if (!query.trim()) return [];
    const response = await this.qdrant.post(
      `/collections/${encodeURIComponent(this.collection)}/points/search`,
      {
        vector: this.embedding(query),
        limit: Math.max(1, Math.min(limit, 20)),
        with_payload: true,
        filter: qdrantShopIsolationFilter(tenantId, marketplaceAccountId),
      },
    );
    const rows = Array.isArray(response.data?.result) ? response.data.result : [];
    return rows
      .map((row: { score?: number; payload?: { product_id?: string } }) => ({
        productId: String(row.payload?.product_id || ''),
        score: Number(row.score || 0),
      }))
      .filter((row: { productId: string }) => row.productId);
  }

  private async requireOwnedShop(tenantId: string, marketplaceAccountId: string) {
    const rows = await AppDataSource.query<Array<{ id: string }>>(
      `SELECT id FROM marketplace_accounts
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [marketplaceAccountId, tenantId],
    );
    if (!rows[0]) throw new Error('SHOP_NOT_FOUND_OR_NOT_OWNED');
  }

  private async rebuildConnectedShops() {
    if (this.automaticRefreshRunning) return;
    this.automaticRefreshRunning = true;
    try {
      const shops = await AppDataSource.query<Array<{
        tenant_id: string;
        marketplace_account_id: string;
      }>>(
        `SELECT account.tenant_id,
                account.id AS marketplace_account_id
         FROM marketplace_accounts account
         JOIN marketplace_credentials credential
           ON credential.marketplace_account_id = account.id
         WHERE account.connection_status = 'CONNECTED'
           AND account.deleted_at IS NULL`,
      );
      for (const shop of shops) {
        try {
          await this.build(shop.tenant_id, shop.marketplace_account_id);
        } catch (error) {
          console.error(
            `Automatic shop knowledge refresh failed for ${shop.marketplace_account_id}:`,
            error,
          );
        }
      }
    } catch (error) {
      console.error('Automatic shop knowledge refresh failed:', error);
    } finally {
      this.automaticRefreshRunning = false;
    }
  }

  private async indexSnapshot(snapshot: ShopCatalogSnapshot) {
    await this.ensureQdrantCollection();
    const filter = qdrantShopIsolationFilter(
      snapshot.tenantId,
      snapshot.marketplaceAccountId,
    );
    await this.qdrant.post(
      `/collections/${encodeURIComponent(this.collection)}/points/delete?wait=true`,
      { filter },
    );
    if (snapshot.products.length === 0) return 0;
    const points = snapshot.products.map((product) => {
      const colors = [...new Set(product.variants.map((variant) => variant.color).filter(Boolean))];
      const sizes = [...new Set(product.variants.map((variant) => variant.size).filter(Boolean))];
      const text = [
        product.name,
        product.brand,
        product.category,
        product.description,
        ...colors,
        ...sizes,
        ...product.variants.flatMap((variant) => [variant.name, variant.sku]),
      ].filter(Boolean).join(' ');
      return {
        id: product.id,
        vector: this.embedding(text),
        payload: {
          tenant_id: snapshot.tenantId,
          marketplace_account_id: snapshot.marketplaceAccountId,
          product_id: product.id,
          product_name: product.name,
          colors,
          sizes,
          catalog_version: snapshot.version,
        },
      };
    });
    await this.qdrant.put(
      `/collections/${encodeURIComponent(this.collection)}/points?wait=true`,
      { points },
    );
    return points.length;
  }

  private async cacheSnapshot(snapshot: ShopCatalogSnapshot) {
    const redis = await this.redisClient();
    await redis.set(
      this.cacheKey(snapshot.tenantId, snapshot.marketplaceAccountId),
      JSON.stringify(snapshot),
      'EX',
      Math.max(60, this.cacheTtlSeconds),
    );
  }

  private cacheKey(tenantId: string, marketplaceAccountId: string) {
    return `ai:shop-knowledge:${tenantId}:${marketplaceAccountId}:snapshot`;
  }

  private async redisClient() {
    if (!this.redis) {
      this.redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0', {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableReadyCheck: true,
        enableOfflineQueue: false,
        connectTimeout: 1500,
      });
      this.redis.on('error', () => undefined);
    }
    if (this.redis.status === 'wait') await this.redis.connect();
    return this.redis;
  }

  private async ensureQdrantCollection() {
    try {
      await this.qdrant.get(`/collections/${encodeURIComponent(this.collection)}`);
      return;
    } catch (error) {
      if (!axios.isAxiosError(error) || error.response?.status !== 404) throw error;
    }
    await this.qdrant.put(`/collections/${encodeURIComponent(this.collection)}`, {
      vectors: { size: this.vectorSize, distance: 'Cosine' },
    });
    for (const field of ['tenant_id', 'marketplace_account_id']) {
      try {
        await this.qdrant.put(
          `/collections/${encodeURIComponent(this.collection)}/index`,
          { field_name: field, field_schema: 'keyword' },
        );
      } catch {
        // Index creation is an optimization; filtered retrieval remains correct without it.
      }
    }
  }

  private embedding(text: string) {
    const vector = Array.from({ length: this.vectorSize }, () => 0);
    const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const words = normalized.split(/[^a-z0-9]+/).filter((word) => word.length >= 2);
    const features = [...words];
    for (const word of words) {
      for (let index = 0; index <= word.length - 3; index += 1) {
        features.push(word.slice(index, index + 3));
      }
    }
    for (const feature of features) {
      const digest = createHash('sha256').update(feature).digest();
      const index = digest.readUInt32BE(0) % this.vectorSize;
      vector[index] += digest[4] % 2 === 0 ? 1 : -1;
    }
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
    return vector.map((value) => value / norm);
  }

  private async markBuilding(tenantId: string, marketplaceAccountId: string) {
    await AppDataSource.query(
      `INSERT INTO ai_shop_knowledge_status (
         tenant_id, marketplace_account_id, status, updated_at
       ) VALUES ($1, $2, 'BUILDING', CURRENT_TIMESTAMP)
       ON CONFLICT (tenant_id, marketplace_account_id) DO UPDATE SET
         status = 'BUILDING', last_error = NULL, updated_at = CURRENT_TIMESTAMP`,
      [tenantId, marketplaceAccountId],
    );
  }

  private async markFailed(tenantId: string, marketplaceAccountId: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await AppDataSource.query(
      `UPDATE ai_shop_knowledge_status
       SET status = 'FAILED', last_error = $3, updated_at = CURRENT_TIMESTAMP
       WHERE tenant_id = $1 AND marketplace_account_id = $2`,
      [tenantId, marketplaceAccountId, message.slice(0, 2000)],
    );
  }

  private async loadCatalogRows(tenantId: string, marketplaceAccountId: string) {
    return AppDataSource.query<CatalogRow[]>(
      `
        SELECT marketplace_product.id AS product_id,
               COALESCE(
                 NULLIF(marketplace_product.external_title, ''),
                 NULLIF(product_source.payload->>'title', ''),
                 NULLIF(product_source.payload->>'name', ''),
                 marketplace_product.external_product_id
               ) AS product_name,
               NULLIF(product_source.payload->>'description', '') AS description,
               COALESCE(
                 NULLIF(product_source.payload->>'brand_name', ''),
                 NULLIF(product_source.payload->>'brand', '')
               ) AS brand_name,
               COALESCE(
                 NULLIF(product_source.payload->>'category_name', ''),
                 NULLIF(product_source.payload->>'category', '')
               ) AS category_name,
               COALESCE(marketplace_product.last_synced_at,
                        marketplace_product.updated_at) AS updated_at,
               marketplace_variant.id AS variant_id,
               COALESCE(
                 NULLIF(marketplace_variant.raw_payload->>'variant_name', ''),
                 NULLIF(marketplace_variant.raw_payload->>'sku_name', ''),
                 NULLIF(marketplace_variant.external_seller_sku, ''),
                 marketplace_variant.external_sku_id
               ) AS variant_name,
               COALESCE(
                 NULLIF(marketplace_variant.external_seller_sku, ''),
                 marketplace_variant.external_sku_id
               ) AS seller_sku,
               marketplace_variant.raw_payload AS variant_attributes,
               COALESCE(marketplace_variant.external_price, 0)::text AS price,
               COALESCE(
                 NULLIF(marketplace_variant.raw_payload->>'currency', ''),
                 NULLIF(product_source.payload->>'currency', ''),
                 'VND'
               ) AS currency,
               GREATEST(COALESCE(marketplace_variant.external_stock, 0), 0)
                 AS available_stock
        FROM marketplace_products marketplace_product
        CROSS JOIN LATERAL (
          SELECT COALESCE(marketplace_product.raw_payload->0, '{}'::jsonb) AS payload
        ) product_source
        JOIN marketplace_product_variants marketplace_variant
          ON marketplace_variant.marketplace_product_id = marketplace_product.id
         AND marketplace_variant.tenant_id = marketplace_product.tenant_id
         AND marketplace_variant.deleted_at IS NULL
         AND marketplace_variant.canonical_status = 'ACTIVE'
         AND marketplace_variant.sync_status = 'SYNCED'
         AND marketplace_variant.last_synced_at IS NOT NULL
        WHERE marketplace_product.tenant_id = $1
          AND marketplace_product.marketplace_account_id = $2
          AND marketplace_product.deleted_at IS NULL
          AND marketplace_product.canonical_status = 'ACTIVE'
          AND marketplace_product.sync_status = 'SYNCED'
          AND marketplace_product.last_synced_at IS NOT NULL
          AND jsonb_typeof(marketplace_product.raw_payload) = 'array'
        ORDER BY marketplace_product.last_synced_at DESC,
                 marketplace_variant.last_synced_at DESC
      `,
      [tenantId, marketplaceAccountId],
    );
  }

  private groupRows(rows: CatalogRow[]) {
    const products = new Map<string, ShopCatalogProduct>();
    for (const row of rows) {
      let product = products.get(row.product_id);
      if (!product) {
        product = {
          id: row.product_id,
          name: row.product_name,
          description: compactText(row.description, 500),
          brand: row.brand_name,
          category: row.category_name,
          updatedAt: new Date(row.updated_at).toISOString(),
          variants: [],
        };
        products.set(row.product_id, product);
      }
      const color = textAttribute(row.variant_attributes, 'color');
      const size = textAttribute(row.variant_attributes, 'size');
      const variantName = textAttribute(row.variant_attributes, 'variantName')
        || row.variant_name
        || [color, size].filter(Boolean).join(' / ')
        || row.seller_sku;
      product.variants.push({
        id: row.variant_id,
        name: variantName,
        sku: row.seller_sku,
        color,
        size,
        price: row.price,
        currency: row.currency,
        availableStock: Number(row.available_stock),
      });
    }
    return [...products.values()];
  }
}

export const shopKnowledgeService = new ShopKnowledgeService();
