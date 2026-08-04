import {
  shopKnowledgeService,
  type ShopCatalogProduct,
} from './shopKnowledge.service';

const STOP_WORDS = new Set([
  'anh', 'ban', 'ben', 'cac', 'cho', 'chi', 'co', 'cua', 'em', 'gi', 'khong',
  'loai', 'minh', 'muon', 'nhung', 'nao', 'pham', 'san', 'shop', 'tim', 'va',
  'voi', 'xin', 'chao', 'size', 'mau', 'kich', 'thuoc', 'gia', 'ton', 'kho',
]);

function normalize(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

function searchWords(message: string) {
  return [...new Set(
    normalize(message)
      .split(/[^a-z0-9_-]+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 2 && !STOP_WORDS.has(word)),
  )].slice(0, 8);
}

function productIntent(message: string) {
  return /sản phẩm|biến thể|sku|size|kích cỡ|kích thước|màu|mẫu|áo|quần|giày|dép|túi|còn hàng|tồn kho|giá/i
    .test(message);
}

function scoreProduct(product: ShopCatalogProduct, words: string[]) {
  const name = normalize(product.name);
  const description = normalize(product.description);
  const brand = normalize(product.brand || '');
  const category = normalize(product.category || '');
  const variants = product.variants.map((variant) => normalize([
    variant.name,
    variant.sku,
    variant.color,
    variant.size,
  ].filter(Boolean).join(' '))).join(' ');
  return words.reduce((score, word) => score
    + (name.includes(word) ? 6 : 0)
    + (variants.includes(word) ? 4 : 0)
    + (brand.includes(word) || category.includes(word) ? 2 : 0)
    + (description.includes(word) ? 1 : 0), 0);
}

export class HybridProductRetrieverService {
  async retrieve(tenantId: string, marketplaceAccountId: string, message: string) {
    if (!productIntent(message)) return null;
    const words = searchWords(message);
    const snapshot = await shopKnowledgeService.getOrBuild(tenantId, marketplaceAccountId);
    const keywordCandidates = snapshot.products
      .map((product) => ({ product, score: scoreProduct(product, words) }))
      .filter((candidate) => words.length === 0 || candidate.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10);
    let vectorCandidates: Array<{ productId: string; score: number }> = [];
    try {
      vectorCandidates = await shopKnowledgeService.vectorSearch(
        tenantId,
        marketplaceAccountId,
        message,
        10,
      );
    } catch {
      vectorCandidates = [];
    }
    const candidateIds = [...new Set([
      ...keywordCandidates.map((candidate) => candidate.product.id),
      ...vectorCandidates.filter((candidate) => candidate.score >= 0.15)
        .map((candidate) => candidate.productId),
    ])].slice(0, 12);
    const productsById = new Map(snapshot.products.map((product) => [product.id, product]));
    const matches = candidateIds
      .map((productId) => productsById.get(productId))
      .filter((product): product is ShopCatalogProduct => Boolean(product))
      .slice(0, 8)
      .map((product) => ({
        product_id: product.id,
        product_name: product.name,
        ...(product.brand ? { brand_name: product.brand } : {}),
        variants: product.variants.map((variant) => ({
          variant_name: variant.name,
          seller_sku: variant.sku,
          ...(variant.color ? { color: variant.color } : {}),
          ...(variant.size ? { size: variant.size } : {}),
          price: variant.price,
          currency: variant.currency,
          available_stock: variant.availableStock,
        })),
      }));
    if (matches.length === 0) return null;
    return { query: message, matches };
  }
}

export const hybridProductRetriever = new HybridProductRetrieverService();
