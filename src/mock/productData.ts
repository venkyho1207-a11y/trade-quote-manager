import type { Product } from '../types/product'

const STORAGE_KEY = 'trade-quote-products'

export const demoProducts: Product[] = [
  {
    id: 'p-1001',
    name: '高密度防水旅行袋',
    sku: 'TRAVEL-BAG-01',
    cost: 18.5,
    image: '',
    specification: '600D 牛津布 / 45×30×22cm / 黑色',
    note: '可按客户要求定制LOGO，建议起订量500件。',
    suppliers: [
      { id: 'q-1', supplierName: '宁波远航箱包', contact: '王经理', quote: 18.5, inquiryDate: '2026-10-28', note: '含普通包装' },
      { id: 'q-2', supplierName: '义乌创达贸易', contact: '李女士', quote: 19.2, inquiryDate: '2026-10-24', note: '含彩盒包装' },
    ],
    createdAt: '2026-10-20',
    updatedAt: '2026-10-28',
  },
  {
    id: 'p-1002',
    name: '便携式硅胶折叠水杯',
    sku: 'CUP-SILICONE-02',
    cost: 6.8,
    image: '',
    specification: '食品级硅胶 / 350ml / 多色可选',
    note: '通过LFGB认证。',
    suppliers: [
      { id: 'q-3', supplierName: '东莞优品硅胶', contact: '陈先生', quote: 6.8, inquiryDate: '2026-10-30', note: '' },
    ],
    createdAt: '2026-10-18',
    updatedAt: '2026-10-30',
  },
  {
    id: 'p-1003',
    name: 'USB-C 多功能扩展坞',
    sku: 'HUB-USBC-03',
    cost: 42,
    image: '',
    specification: '铝合金 / HDMI+USB3.0+PD / 灰色',
    note: '支持OEM彩盒及说明书。',
    suppliers: [],
    createdAt: '2026-10-12',
    updatedAt: '2026-10-12',
  },
]

export function loadProducts(): Product[] {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (!stored) return structuredClone(demoProducts)

  try {
    return JSON.parse(stored) as Product[]
  } catch {
    return structuredClone(demoProducts)
  }
}

export function saveProducts(products: Product[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(products))
}
