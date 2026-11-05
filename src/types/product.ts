export interface SupplierQuote {
  id: string
  supplierName: string
  contact: string
  quote: number
  inquiryDate: string
  note?: string
}

export interface Product {
  id: string
  name: string
  sku: string
  cost: number
  image?: string
  specification: string
  note: string
  suppliers: SupplierQuote[]
  createdAt: string
  updatedAt: string
}

export type ProductForm = Omit<Product, 'id' | 'suppliers' | 'createdAt' | 'updatedAt'> & {
  supplierIds: string[]
}
