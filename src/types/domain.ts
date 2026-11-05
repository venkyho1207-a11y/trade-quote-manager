export interface SupplierQuote {
  id: string
  supplierName: string
  contact: string
  quote: number
  inquiryDate: string
  note: string
}

export interface Product {
  id: string
  name: string
  sku: string
  model: string
  cost: number
  image: string
  specification: string
  description: string
  surfaceTreatment: string
  moq: number
  packingQuantity: number
  packingRequirement: string
  note: string
  // 单证参数：单位、HS 编码，以及单箱毛净重/体积/尺寸（总箱数由总数÷装箱数推算）
  unit: string
  hsCode: string
  cartonGrossWeight: number
  cartonNetWeight: number
  cartonVolume: number
  cartonSize: string
  supplierIds: string[]
  suppliers: SupplierQuote[]
  createdAt: string
  updatedAt: string
}

export interface Supplier {
  id: string
  name: string
  contact: string
  position: string
  whatsapp: string
  phone: string
  email: string
  address: string
  note: string
  productIds: string[]
  createdAt: string
}

export type CustomerType = '新客户' | '订单客户' | '样单客户' | '重潜在客户' | '轻潜在客户'

export interface CustomerFollowUp {
  id: string
  customerId: string
  followedAt: string
  content: string
  createdAt: string
}

export interface Customer {
  id: string
  code: string
  name: string
  type: CustomerType
  country: string
  timezone: string
  business: string
  website: string
  contact: string
  phone: string
  address: string
  email: string
  // 单证模板需要买家邮编与传真
  zip: string
  fax: string
  salesperson: string
  note: string
  lastFollowUpAt: string | null
  nextFollowUpAt: string | null
  followupStage: number
  daysLeft: number | null
  createdAt: string
}

export type QuoteCurrency = 'CNY' | 'USD'

export interface QuoteItem {
  id: string
  productId: string
  productName: string
  sku: string
  // 单证填充需要产品型号/规格/描述，随报价单一起返回
  model: string
  specification: string
  description: string
  // 产品库里的单证参数快照，生成时作为默认值
  image: string
  unit: string
  hsCode: string
  packingQuantity: number
  cartonGrossWeight: number
  cartonNetWeight: number
  cartonVolume: number
  cartonSize: string
  quantity: number
  cost: number
  packagingFee: number
  profit: number
  exwUnitPrice: number
  fobUnitPrice: number
  cifUnitPrice: number
  selectedUnitPrice: number
  totalPrice: number
  tradeTerm: 'EXW' | 'FOB' | 'CIF'
  // 行定价币种：人民币按公式算，美元则手动单价按美元填、保存时换算回人民币存储
  priceCurrency: QuoteCurrency
}

export interface Quote {
  id: string
  quoteNo: string
  customerId: string
  customerCode: string
  customerName: string
  customerCountry: string
  customerContact: string
  customerEmail: string
  customerAddress: string
  customerZip: string
  customerFax: string
  mode: '散货' | '整柜'
  tradeTerm: 'EXW' | 'FOB' | 'CIF'
  domesticFreight: number
  customsFee: number
  bankFee: number
  oceanFreight: number
  insuranceFee: number
  paymentNote: string
  totalQuantity: number
  totalAmount: number
  // 结算币种 + 保存时汇率快照
  currency: QuoteCurrency
  exchangeRate: number
  items: QuoteItem[]
  createdAt: string
  updatedAt: string
}

export interface ExchangeRate {
  rate: number
  source: string
  updatedAt: string
}

// 我的企业（卖方）：单条记录，存公司抬头与银行收款信息
export interface MyCompany {
  id: string
  nameCn: string
  nameEn: string
  addressCn: string
  addressEn: string
  tel: string
  fax: string
  email: string
  website: string
  zip: string
  unifiedCode: string
  customsCode: string
  logo: string
  beneficiaryAccount: string
  swiftCode: string
  beneficiaryCountry: string
  beneficiaryName: string
  beneficiaryAddress: string
  beneficiaryBank: string
  beneficiaryBankAddress: string
  bankCode: string
  branchCode: string
  updatedAt: string
}

export type DocType = 'PI' | '报价单' | '商业发票' | '装箱单' | '报关单' | '其他'

// 单元格映射：值为字段键字符串，或 { field, append } / { block: string[] }
export type CellMapping = string | { field?: string; append?: boolean; block?: string[] }
export interface TemplateMapping {
  sheet?: string
  cells?: Record<string, CellMapping>
  items?: { startRow?: number; columns?: Record<string, string> }
}

export interface DocumentTemplate {
  id: string
  name: string
  docType: DocType
  fileName: string
  mapping: TemplateMapping
  createdAt: string
  updatedAt: string
}

export interface TemplateStructureCell {
  row: number
  col: number
  address: string
  text: string
}
export interface TemplateStructureSheet {
  name: string
  rowCount: number
  columnCount: number
  cells: TemplateStructureCell[]
  merges: string[]
}

// 单证补充字段：起运地、唛头、HS 编码等非固定项，随报价单保存
export interface QuoteDocumentItemExtra {
  unit: string
  hsCode: string
  ctns: string
  gw: string
  nw: string
  cbm: string
  size: string
}
export interface QuoteDocumentFields {
  from: string
  to: string
  vessel: string
  marks: string
  poNo: string
  scNo: string
  loadingDate: string
  countryOfOrigin: string
  termOfDelivery: string
  remark: string
  items: Record<string, QuoteDocumentItemExtra>
}

export interface DocFieldGroup {
  group: string
  items: Array<[string, string]>
}

// 单证预览结果：二维文本 + 合并区域；图片无法在文本表格呈现，只回报数量
export interface DocumentPreview {
  sheet: string
  columnCount: number
  rows: Array<{ row: number; cells: string[] }>
  merges: string[]
  imageCount: number
}
